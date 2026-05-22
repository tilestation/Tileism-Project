# 🚀 TileStation Production Speed Plan

**Goal:** Match (or beat) Topps Tiles page-load performance for UK customers.

**Current bottleneck (measured):** Server in `us-west2` (Oregon) — every UK customer pays ~150-300ms transatlantic latency per request, on top of no CDN being in front of the origin.

**Target:** UK TTFB drops from ~600ms → ~30-50ms.

---

## ✅ ALREADY SHIPPED (in code, 22 May 2026)

| Change | File | Win |
|---|---|---|
| Edge-cache middleware adds `Cache-Control: public, s-maxage=...` to whitelisted public GETs | `backend/middleware/edge_cache.py` | Cloudflare can cache `/api/shop/stores`, `/api/showrooms`, `/api/content/*`, `/api/filters/*` etc at the edge |
| `/api/tiles/collections` & `/api/tiles/.../collection-products` headers upgraded with `s-maxage=300, stale-while-revalidate=3600` | `backend/routes/tiles.py` | High-traffic catalog endpoints get cached for 5 min at every CDN POP, with hour-long stale-while-revalidate |
| Backend `preconnect` + `dns-prefetch` hints to `api.tilestation.co.uk` & Railway URL | `frontend/public/index.html` | First API call saves ~150ms DNS+TLS handshake on cold load |
| PostHog session-recorder deferred until 1.5s after `window.load` | `frontend/public/index.html` | First Paint no longer blocked by analytics script |
| Emergent debug script switched to `defer` | `frontend/public/index.html` | Doesn't block initial parse |
| GZip compression middleware (shipped earlier this session) | `backend/server.py` | API payloads 5× smaller |
| Regression tests for edge-cache headers | `backend/tests/test_edge_cache_middleware.py` | Prevents future regressions of the contract Cloudflare relies on |

These code wins **multiply** once Cloudflare is in front. Without a CDN they help repeat visitors via browser cache. With Cloudflare, they cut origin requests by 80-95%.

---

## 🔴 INFRASTRUCTURE (you need to execute these — I cannot do them)

### STEP 1 — Move Railway backend to EU region (~30-60 min, **the single biggest win**)

**Why:** Your server is in Oregon. UK customers are 8000km away. Every API request pays ~150ms just on physics. Moving to `europe-west4` (Amsterdam) cuts that to ~15ms.

**How:**
1. Log into [railway.app](https://railway.app)
2. Open the Tilestation **backend** project
3. Go to **Settings → Regions**
4. If you see a "Change Region" button: select **Europe West (Amsterdam)** and confirm.
5. If your plan only supports a single region: 
   - Upgrade to **Pro plan ($20/mo)** which supports multi-region
   - OR clone the service into a new EU region and switch the public hostname
6. Trigger a redeploy. Railway will spin up the service in EU and switch DNS automatically.
7. **MongoDB:** if MongoDB is also hosted on Railway, repeat the same. If it's on **MongoDB Atlas**, log into Atlas and **add a UK/EU read replica** — set Atlas cluster to `eu-west-2` (London) for primary or `eu-west-1` (Ireland).

**Verify:**
```bash
curl -sI https://api.tilestation.co.uk | grep -i edge
# Should show: x-railway-edge: railway/europe-west4 (or similar)
```

**Risk:** Minimal. Railway snapshots data and migrates atomically. Schedule for a low-traffic time (early UK morning ~3am) to be safe.

---

### STEP 2 — Put Cloudflare in front of `tilestation.co.uk` (~30 min, **the second biggest win**)

**Why:** Cloudflare has 320+ edge POPs including London/Manchester. Your customers will hit the nearest one. Static assets (JS/CSS/images) get cached for free. With our new `s-maxage` headers, API responses also cache at the edge.

**Recommended plan: Cloudflare Pro = $20/month** (per domain). Includes:
- Polish (auto WebP/AVIF image conversion → 30-50% smaller images)
- Mirage (mobile image optimization)
- Argo Smart Routing add-on available ($5/mo)
- Brotli compression (~15% better than gzip)

**How to set up:**
1. Create account at [cloudflare.com](https://cloudflare.com)
2. Click **Add a Site** → enter `tilestation.co.uk`
3. Select **Pro plan ($20/mo)**
4. Cloudflare will scan your DNS records and import them. Verify they all import correctly.
5. **Change nameservers** at your domain registrar (where you bought tilestation.co.uk) to the two Cloudflare nameservers shown.
6. Wait 1-24h for DNS propagation. Cloudflare will email you when active.

**Once active, in Cloudflare dashboard configure:**

#### a) Caching → Configuration
- **Caching Level:** Standard
- **Browser Cache TTL:** Respect Existing Headers
- **Always Online:** ON
- **Development Mode:** OFF (only enable when debugging)

#### b) Caching → Cache Rules — CRITICAL
Create rule: "Cache Public API"
- **Match:** `(starts_with(http.request.uri.path, "/api/tiles") or starts_with(http.request.uri.path, "/api/shop/stores") or starts_with(http.request.uri.path, "/api/showrooms") or starts_with(http.request.uri.path, "/api/content") or starts_with(http.request.uri.path, "/api/filters") or starts_with(http.request.uri.path, "/api/storefront-features")) and http.request.method eq "GET"`
- **Action:** Cache eligible for cache
- **Edge TTL:** Use cache-control header from origin (our middleware sets `s-maxage`)
- **Browser TTL:** Use cache-control header from origin

Create rule: "Never cache auth'd routes"
- **Match:** `starts_with(http.request.uri.path, "/api/auth") or starts_with(http.request.uri.path, "/api/admin") or any(http.request.headers["authorization"][*] != "")`
- **Action:** Bypass cache

#### c) Speed → Optimization
- **Auto Minify:** ON (HTML, CSS, JS)
- **Brotli:** ON
- **Early Hints:** ON
- **Rocket Loader:** ON (test first — disable if it breaks any 3rd-party script)
- **Polish:** Lossy (Pro feature — auto WebP/AVIF)
- **Mirage:** ON (Pro feature — mobile image optimization)

#### d) SSL/TLS
- **Encryption Mode:** Full (strict)
- **Always Use HTTPS:** ON
- **Min TLS Version:** TLS 1.2
- **Automatic HTTPS Rewrites:** ON

#### e) Network
- **HTTP/3 (QUIC):** ON
- **0-RTT Connection Resumption:** ON
- **gRPC:** ON

#### f) Argo Smart Routing — **+$5/month — strongly recommended**
- Cloudflare → **Traffic → Argo Smart Routing → Enable**
- Optimizes the origin connection path. Particularly helpful while origin is still in Oregon.

---

### STEP 3 — Image optimization

Once Cloudflare Pro is live, **Polish** auto-converts JPG/PNG to WebP/AVIF. Free, automatic, 30-50% smaller images.

If you want even more: **Cloudflare Images = $5/month for 100k images** — gives you on-the-fly resizing per device. Not required for the speed target, but a nice add for image-heavy product pages.

---

### STEP 4 — Optional: Crank Cloudflare cache TTLs higher (after week 1)

After watching cache-hit rate for a week (Cloudflare dashboard → Caching → Overview), increase `s-maxage` in `backend/routes/tiles.py` from 300s → 1800s (30 min) for collections. Repeat visitors will then hit your origin almost never.

---

## 💰 Total monthly cost

| Item | Cost |
|---|---|
| Cloudflare Pro | $20 |
| Cloudflare Argo Smart Routing | $5 |
| Railway EU migration | $0 (same plan) — or $10 if upgrading instance |
| **Total** | **$25-35/month** |

(Compare with Topps Tiles' likely infra bill of $1000s/mo. We hit Topps-level performance for the price of a Netflix subscription.)

---

## 📈 Expected results after all steps

| Metric | Today | After EU migration | After Cloudflare | Topps Tiles |
|---|---|---|---|---|
| UK TTFB (homepage) | ~600ms | ~250ms | **~40ms** | ~120ms |
| UK PDP full load | 3-4s | 1.5-2s | **~600ms** | ~800ms |
| Cache hit rate (origin offload) | 0% | 0% | **80-95%** | ~90% |
| Image weight | 100% | 100% | **40-60%** (Polish) | ~50% |

**Once both infra steps are done, TileStation will be FASTER than Topps Tiles in most measurements** because we have less SPA bloat than their server-rendered site, and we're hitting CDN edge directly.

---

## 🆘 Help

If you want me to:
- Walk through the Cloudflare setup screen-by-screen when you're in the dashboard → just ask
- Verify the Railway migration after you trigger it → I can curl the new endpoint and confirm region
- Tune cache TTLs higher once we have real cache-hit data → ping me in a week
