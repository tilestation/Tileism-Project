/**
 * Route → SEO metadata mapping for the production Express server.
 *
 * Why this exists
 * ---------------
 * The storefront is a CRA-built SPA: every URL serves the same
 * `build/index.html` shell. The shell has no static <title> or
 * <meta description> — those are set client-side via React 19's
 * built-in metadata API once the bundle has executed.
 *
 * Crawlers that DON'T execute JavaScript (Semrush, AhrefsBot, Bingbot
 * by default, and historically the "first pass" of Googlebot) read
 * the raw HTML and see an empty title + missing description. That
 * scored us 57 "Title tag missing or empty" errors and 37
 * "Duplicate pages without canonical" errors on the May 3 2026
 * Semrush crawl (Health Score 46).
 *
 * Fix: at request time, the Express server inspects the URL path and
 * injects a route-specific <title>, <meta description>, and
 * <link rel="canonical"> into the served HTML. Crawlers see real
 * metadata; users get the same SPA bundle they always did.
 *
 * Strategy
 * --------
 *   1. Try EXACT match (e.g. `/`, `/about`, `/contact`).
 *   2. Try PREFIX match (e.g. `/tiles/...`, `/collections/...`,
 *      `/installer/...`) and slugify the dynamic tail into the title.
 *   3. Fallback: brand-only title.
 *
 * Every match also produces a canonical URL by stripping query
 * strings and trailing slashes (Semrush flags `?ref=` and `?page=2`
 * variants as duplicates without canonical).
 */

const SITE_URL = process.env.PUBLIC_SITE_URL || 'https://tilestation.co.uk';
const BRAND = 'Tile Station';

// Prettify a slug like "spanish-floor-tiles-60x60" → "Spanish Floor Tiles 60x60"
const titleCase = (slug) => {
  if (!slug) return '';
  return slug
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (m) => m.toUpperCase())
    .trim();
};

const ORG_JSONLD = {
  '@context': 'https://schema.org',
  '@type': 'Organization',
  name: BRAND,
  url: SITE_URL,
  logo: `${SITE_URL}/icon-192.png`,
  description: 'UK tile and stone specialist with four showrooms across Kent, Essex and London.',
  address: [
    {
      '@type': 'PostalAddress',
      streetAddress: 'Tonbridge Showroom',
      addressLocality: 'Tonbridge',
      addressRegion: 'Kent',
      addressCountry: 'GB',
    },
    {
      '@type': 'PostalAddress',
      streetAddress: 'Chingford Showroom',
      addressLocality: 'Chingford',
      addressRegion: 'Greater London',
      addressCountry: 'GB',
    },
    {
      '@type': 'PostalAddress',
      streetAddress: 'Gravesend Showroom',
      addressLocality: 'Gravesend',
      addressRegion: 'Kent',
      addressCountry: 'GB',
    },
    {
      '@type': 'PostalAddress',
      streetAddress: '329-331 Sydenham Road',
      addressLocality: 'Sydenham, London',
      postalCode: 'SE26 5EQ',
      addressRegion: 'Greater London',
      addressCountry: 'GB',
    },
  ],
  sameAs: [],
};

const WEBSITE_JSONLD = {
  '@context': 'https://schema.org',
  '@type': 'WebSite',
  name: BRAND,
  url: SITE_URL,
  potentialAction: {
    '@type': 'SearchAction',
    target: `${SITE_URL}/shop?search={search_term_string}`,
    'query-input': 'required name=search_term_string',
  },
};

// Static pages — exact path → SEO meta
const EXACT = {
  '/': {
    title: `${BRAND} — Premium Tiles, Bathrooms and Flooring · UK Showrooms in Tonbridge, Chingford, Gravesend & Sydenham`,
    description: 'UK tile, bathroom and flooring specialists with four showrooms across Kent, Essex and London. Browse 1,000+ porcelain, marble, terrazzo, vinyl and engineered wood with free samples and trade pricing.',
    jsonld: { '@context': 'https://schema.org', '@graph': [ORG_JSONLD, WEBSITE_JSONLD] },
  },
  '/tiles': {
    title: `Shop All Tiles · ${BRAND}`,
    description: 'Browse our full range of porcelain, marble, terrazzo, ceramic, vinyl and engineered wood. Free samples, trade prices, fast UK delivery.',
  },
  '/collections': {
    title: `Tile Collections · ${BRAND}`,
    description: 'Explore curated tile collections by style, room and finish. Spanish floor tiles, Italian marble, terrazzo, large-format slabs and more.',
  },
  '/about': {
    title: `About ${BRAND} — UK Tile Specialists Since 1985`,
    description: 'Family-run tile and stone supplier with four Kent, Essex and London showrooms. Trade and retail customers welcome.',
  },
  '/contact': {
    title: `Contact ${BRAND} — Showroom Locations & Trade Enquiries`,
    description: 'Visit our Tonbridge, Chingford, Gravesend or Sydenham showrooms, or get in touch with our trade team for project quotes.',
  },
  '/showrooms': {
    title: `Tile Showrooms in Tonbridge, Chingford, Gravesend & Sydenham · ${BRAND}`,
    description: 'Visit one of our four UK tile showrooms — see thousands of tiles in person, take home free samples, and chat to our specialists.',
  },
  '/installer': {
    title: `Find a Tile Installer Near You · ${BRAND}`,
    description: 'Connect with vetted tile and stone installers across the UK. Local fitters for kitchens, bathrooms, hallways, fireplaces and outdoor projects.',
  },
  '/sample-box': {
    title: `Free Tile Samples — Order Your Sample Box · ${BRAND}`,
    description: 'Order free tile samples delivered to your door. Touch, feel and compare tiles in your own light before you commit to a full order.',
  },
  '/wishlist': { title: `Your Wishlist · ${BRAND}`, description: 'Tiles you\'ve saved to your wishlist.' },
  '/basket': { title: `Your Basket · ${BRAND}`, description: 'Your tile basket and order summary.' },
  '/checkout': { title: `Checkout · ${BRAND}`, description: 'Complete your tile order — secure UK checkout.' },
  '/account': { title: `My Account · ${BRAND}`, description: 'Manage your Tile Station account, orders and addresses.' },
  '/login': { title: `Sign In · ${BRAND}`, description: 'Sign in to your Tile Station account.' },
  '/register': { title: `Create Account · ${BRAND}`, description: 'Create a Tile Station account for faster checkout and saved samples.' },
  '/trade': { title: `Trade Account · ${BRAND}`, description: 'Apply for a Tile Station trade account — exclusive pricing and credit terms for installers, contractors and developers.' },
  '/blog': { title: `Blog · ${BRAND}`, description: 'Tile, bathroom and flooring guides, design inspiration, installation tips and supplier news from the Tile Station team.' },
  '/faq': { title: `FAQ · ${BRAND}`, description: 'Answers to the most common tile, stone, sample and delivery questions.' },
  '/delivery': { title: `Delivery & Returns · ${BRAND}`, description: 'How we deliver tiles across the UK, lead times, returns and breakage policy.' },
  '/privacy': { title: `Privacy Policy · ${BRAND}`, description: 'How Tile Station handles your data. GDPR-compliant.' },
  '/terms': { title: `Terms & Conditions · ${BRAND}`, description: 'Tile Station terms of sale, returns and warranties.' },
  '/status': { title: `System Status · ${BRAND}`, description: 'Live status of our storefront, sample ordering and delivery systems.' },
  '/visualizer': { title: `Tile Visualizer (Coming Soon) · ${BRAND}`, description: 'See real tiles in your own room photo before you buy. Join the early-access waitlist.' },

  // ───────────────────────────────────────────────────────────────
  // 13 May 2026 — added /clearance + /new-collection EXACT rules so
  // they get unique, descriptive titles instead of falling through to
  // FALLBACK (which is brand-only). Both are in sitemap.xml so Google
  // indexes them; unique titles avoid the duplicate-title cluster.
  // ───────────────────────────────────────────────────────────────
  '/clearance': {
    title: `Tile, Bathroom & Flooring Clearance — Up to 70% Off · ${BRAND}`,
    description: 'Last-chance deals on porcelain, marble, terrazzo, vinyl and engineered wood. Discontinued lines, end-of-roll vinyl, ex-display bathroom suites — while stocks last.',
  },
  '/new-collection': {
    title: `New In — Fresh Tile, Bathroom & Flooring Collections · ${BRAND}`,
    description: 'Browse the latest arrivals — new porcelain, marble, terrazzo, vinyl plank and engineered wood ranges added this season. Free samples available.',
  },

  // ─────────────────────────────────────────────────────────────────
  // /shop/* exact pages — added 12 May 2026 after Ahrefs flagged 15
  // "Title tag missing or empty" URLs (all returning the FALLBACK
  // generic title because /shop/* never matched any rule). These give
  // every shop-side static page a unique, indexable title.
  // ─────────────────────────────────────────────────────────────────
  '/shop/faq': { title: `FAQ · ${BRAND}`, description: 'Tile & stone FAQs — orders, samples, returns, trade accounts, delivery and installation.' },
  '/shop/sample-service': { title: `Tile Sample Service · ${BRAND}`, description: 'Order tile samples by post and see them in your own light before buying. £2.99 P&P, refunded on purchase.' },
  '/shop/tile-forgot-password': { title: `Reset Your Password · ${BRAND}`, description: 'Reset the password for your Tile Station account.', noindex: true },
  '/shop/tile-login': { title: `Sign In · ${BRAND}`, description: 'Sign in to your Tile Station account.', noindex: true },
  '/shop/tile-register': { title: `Create Account · ${BRAND}`, description: 'Create a Tile Station account for faster checkout, saved samples and order tracking.', noindex: true },
  '/shop/tile-cart': { title: `Your Basket · ${BRAND}`, description: 'Your tile basket and order summary.', noindex: true },
  '/shop/cart': { title: `Your Basket · ${BRAND}`, description: 'Your tile basket and order summary.', noindex: true },
  '/shop/checkout': { title: `Secure Checkout · ${BRAND}`, description: 'Complete your tile order with secure UK checkout.', noindex: true },
  '/shop/account': { title: `My Account · ${BRAND}`, description: 'Manage your Tile Station orders, samples and addresses.', noindex: true },
  '/shop/orders': { title: `My Orders · ${BRAND}`, description: 'View and track your Tile Station orders.', noindex: true },
  '/shop/track': { title: `Track Your Order · ${BRAND}`, description: 'Track your Tile Station order with your order number and email.' },
  '/shop/trade/register': { title: `Trade Account Application · ${BRAND}`, description: 'Apply for a Tile Station trade account — exclusive pricing, 30-day credit and priority service for installers, contractors and developers.' },
  '/shop/trade/account': { title: `Trade Account · ${BRAND}`, description: 'Your Tile Station trade account dashboard.', noindex: true },
  '/shop/bathroom': { title: `Bathroom Tiles & Inspiration · ${BRAND}`, description: 'Bathroom tile ideas, designer inspiration and our complete bathroom tile range — porcelain, marble, terrazzo and more.' },
  '/shop/contact': { title: `Contact Us · Showrooms in Tonbridge, Chingford, Gravesend & Sydenham · ${BRAND}`, description: 'Visit one of our four UK tile showrooms or contact our team for trade enquiries and project quotes.' },
  '/shop/refer': { title: `Refer a Friend & Earn £25 Credit · ${BRAND}`, description: 'Recommend Tile Station to a friend and you both earn £25 credit on your next tile order.' },
  '/shop/compare': { title: `Compare Tiles Side-by-Side · ${BRAND}`, description: 'Compare up to 4 tiles side-by-side: price, size, material, finish and stock.' },
  '/shop/all-tiles': { title: `All Tiles · ${BRAND}`, description: 'Browse our complete range — 1,000+ porcelain, marble, terrazzo, ceramic, vinyl and engineered wood.' },
  '/shop/tiles': { title: `Shop Tiles · ${BRAND}`, description: 'Browse our tile range by material, size, finish and room. Free UK samples and trade pricing.' },
  '/shop/order-success': { title: `Order Confirmed · ${BRAND}`, description: 'Thank you — your Tile Station order has been confirmed.', noindex: true },
  '/shop/wishlist': { title: `Your Wishlist · ${BRAND}`, description: 'Tiles you\'ve saved for later.', noindex: true },
  '/shop/tile-samples': { title: `Order Tile Samples · ${BRAND}`, description: 'Touch, feel and compare tiles in your own light. Sample postage £2.99, refunded on purchase.' },
  '/shop/tile-sample-success': { title: `Sample Order Confirmed · ${BRAND}`, description: 'Thanks — your tile samples are on their way.', noindex: true },
  '/shop/contact-us': { title: `Contact Us · ${BRAND}`, description: 'Get in touch with the Tile Station team — four Kent, Essex and London showrooms.' },
  '/shop/stores': { title: `Visit a Showroom · ${BRAND}`, description: 'Visit our Tonbridge, Chingford, Gravesend or Sydenham tile showrooms.' },
  '/shop/info/faq': { title: `FAQ · ${BRAND}`, description: 'Tile & stone FAQs — orders, samples, returns, trade accounts, delivery and installation.' },
  '/shop/info/privacy': { title: `Privacy Policy · ${BRAND}`, description: 'How Tile Station handles your data. GDPR-compliant.' },
  '/shop/info/terms': { title: `Terms & Conditions · ${BRAND}`, description: 'Tile Station terms of sale, returns and warranties.' },
  '/shop/info/returns': { title: `Returns & Refunds · ${BRAND}`, description: 'Our returns and refunds policy — easy returns within 30 days.' },
  '/shop/info/delivery': { title: `Delivery Information · ${BRAND}`, description: 'UK delivery times, tracking, lead times and breakage policy.' },
  '/shop/info/reviews': { title: `Customer Reviews · ${BRAND}`, description: 'Real customer reviews of our tile and stone products.' },
  '/shop/info/about': { title: `About ${BRAND}`, description: 'Family-run UK tile and stone specialist with four Kent, Essex and London showrooms.' },
  '/shop/info/sample-service': { title: `Sample Service · ${BRAND}`, description: 'How our £2.99 tile sample service works — refunded on every purchase.' },

  // 15 May 2026 — Ahrefs flagged the bare `/shop/<page>` paths as
  // duplicate-without-canonical because they were falling back to the
  // generic brand meta. These mirror the `/shop/info/<page>` variants
  // so both URLs serve the right title/description regardless of
  // which route a customer (or crawler) hits.
  '/shop/delivery': { title: `Delivery Information · ${BRAND}`, description: 'UK delivery times, tracking, lead times and breakage policy.' },
  '/shop/returns': { title: `Returns & Refunds · ${BRAND}`, description: 'Our returns and refunds policy — easy returns within 30 days.' },
  '/shop/about': { title: `About ${BRAND}`, description: 'Family-run UK tile and stone specialist with four Kent, Essex and London showrooms.' },
  '/shop/faq': { title: `FAQ · ${BRAND}`, description: 'Tile & stone FAQs — orders, samples, returns, trade accounts, delivery and installation.' },
  '/shop/privacy': { title: `Privacy Policy · ${BRAND}`, description: 'How Tile Station handles your data. GDPR-compliant.' },
  '/shop/terms': { title: `Terms & Conditions · ${BRAND}`, description: 'Tile Station terms of sale, returns and warranties.' },
  '/shop/reviews': { title: `Customer Reviews · ${BRAND}`, description: 'Real customer reviews of our tile and stone products.' },
  '/shop/sample-service': { title: `Sample Service · ${BRAND}`, description: 'How our £2.99 tile sample service works — refunded on every purchase.' },
};

// Dynamic prefix patterns — first match wins
const PREFIXES = [
  // Product detail: /tiles/:slug or /products/:slug
  {
    pattern: /^\/(?:tiles|products)\/([^/?#]+)\/?$/,
    build: (m) => ({
      title: `${titleCase(m[1])} · ${BRAND}`,
      description: `Buy ${titleCase(m[1])} at ${BRAND} — free samples, fast UK delivery, trade pricing available.`,
    }),
  },
  // Collection page: /collections/:slug
  {
    pattern: /^\/collections\/([^/?#]+)\/?$/,
    build: (m) => ({
      title: `${titleCase(m[1])} Collection · ${BRAND}`,
      description: `Explore the ${titleCase(m[1])} tile collection at ${BRAND}. Free UK samples and trade pricing on every order.`,
    }),
  },
  // Category browse: /tiles/category/:slug or /tiles/:material
  {
    pattern: /^\/tiles\/category\/([^/?#]+)\/?$/,
    build: (m) => ({
      title: `${titleCase(m[1])} Tiles · ${BRAND}`,
      description: `Shop ${titleCase(m[1])} tiles at ${BRAND}. Premium UK supplier — free samples, trade pricing, fast delivery.`,
    }),
  },
  // Local SEO pages: /tile-shop/:city, /tile-shop-near-me/:city
  {
    pattern: /^\/(?:tile-shop|tile-shop-near-me|tile-shops?)\/([^/?#]+)\/?$/,
    build: (m) => ({
      title: `Tile Shop ${titleCase(m[1])} — ${BRAND} Showroom`,
      description: `Tile shop in ${titleCase(m[1])} — visit our showroom or browse 1,000+ tiles online. Free samples and trade pricing.`,
    }),
  },
  // Installer city pages: /installer/:city
  {
    pattern: /^\/installer\/([^/?#]+)\/?$/,
    build: (m) => ({
      title: `Tile Installers in ${titleCase(m[1])} · ${BRAND}`,
      description: `Find vetted tile installers in ${titleCase(m[1])}. Compare quotes, read reviews and book your project with ${BRAND}.`,
    }),
  },
  // Blog post: /blog/:slug
  {
    pattern: /^\/blog\/([^/?#]+)\/?$/,
    build: (m) => ({
      title: `${titleCase(m[1])} · ${BRAND} Blog`,
      description: `${titleCase(m[1])} — expert tile and stone advice from the ${BRAND} team.`,
    }),
  },
  // Visualizer share: /visualizer/share/:token (no-index so just sane title)
  {
    pattern: /^\/visualizer\/share\/[^/?#]+\/?$/,
    build: () => ({
      title: `Shared Tile Visualization · ${BRAND}`,
      description: 'A shared tile visualization from Tile Station\'s room visualizer.',
      noindex: true,
    }),
  },

  // ───────────────────────────────────────────────────────────────
  // /shop/* dynamic patterns — added 12 May 2026 for the Ahrefs
  // "Title tag missing or empty" fix. These produce a unique, static
  // per-page title from the URL slug even when the backend dynamic
  // lookup (enrichSeo) fails or times out — so a collection PDP
  // always has e.g. "Fossil Collection · Tile Station" instead of
  // the brand-only fallback.
  // ───────────────────────────────────────────────────────────────
  // /shop/collection/<name> → "<Name> Collection · Tile Station"
  {
    pattern: /^\/shop\/collection\/([^/?#]+)\/?$/i,
    build: (m) => {
      const name = titleCase(decodeURIComponent(m[1]));
      return {
        title: `${name} Collection · ${BRAND}`,
        description: `Explore the ${name} tile collection at ${BRAND} — free UK samples, trade pricing and fast delivery on every order.`,
      };
    },
  },
  // /shop/product/<slug> → "<Slug> · Tile Station"
  {
    pattern: /^\/shop\/product\/([^/?#]+)\/?$/i,
    build: (m) => {
      const name = titleCase(decodeURIComponent(m[1]));
      return {
        title: `${name} · ${BRAND}`,
        description: `Buy ${name} at ${BRAND} — free samples, fast UK delivery, trade pricing available.`,
      };
    },
  },
  // /shop/products/<slug> (legacy)
  {
    pattern: /^\/shop\/products\/([^/?#]+)\/?$/i,
    build: (m) => {
      const name = titleCase(decodeURIComponent(m[1]));
      return {
        title: `${name} · ${BRAND}`,
        description: `Buy ${name} at ${BRAND} — free samples, fast UK delivery, trade pricing available.`,
      };
    },
  },
  // /shop/tiles/<slug> (legacy PDP)
  {
    pattern: /^\/shop\/tiles\/([^/?#]+)\/?$/i,
    build: (m) => {
      const name = titleCase(decodeURIComponent(m[1]));
      return {
        title: `${name} · ${BRAND}`,
        description: `Buy ${name} at ${BRAND} — free samples, fast UK delivery, trade pricing available.`,
      };
    },
  },
  // /shop/info/<slug> → "<Slug> · Tile Station"
  {
    pattern: /^\/shop\/info\/([^/?#]+)\/?$/i,
    build: (m) => {
      const slug = decodeURIComponent(m[1]);
      const name = titleCase(slug);
      return {
        title: `${name} · ${BRAND}`,
        description: `${name} — ${BRAND} information page.`,
      };
    },
  },
  // /shop/tile-scale-print/<size> → printable scale ruler page, noindex
  {
    pattern: /^\/shop\/tile-scale-print\/[^/?#]+\/?$/i,
    build: () => ({
      title: `Tile Scale Print · ${BRAND}`,
      description: 'Printable to-scale tile rulers for visualising tile sizes before ordering.',
      noindex: true,
    }),
  },
  // /shop/collection/<name>/* → catch-all sub-paths under a collection
  // (these are mostly bot-probed URLs like /shop/collection/X/shop/track,
  // but our server.js 301 catches those before they reach here)
  {
    pattern: /^\/shop\/collection\/([^/?#]+)\/[^/?#]+\/?$/i,
    build: (m) => {
      const name = titleCase(decodeURIComponent(m[1]));
      return {
        title: `${name} Collection · ${BRAND}`,
        description: `Explore the ${name} tile collection at ${BRAND}.`,
        noindex: true,  // sub-paths are not canonical
      };
    },
  },
];

const FALLBACK = {
  title: `${BRAND} — Premium Tiles, Bathrooms and Flooring`,
  description: 'UK tile, bathroom and flooring specialists with four showrooms. Browse 1,000+ porcelain, marble, terrazzo, vinyl and engineered wood.',
};

/**
 * Resolve SEO metadata for a given pathname (no query/hash).
 *
 * Returns `{ title, description, canonical, noindex }`.
 */
function resolveSeo(rawPath) {
  // Normalise: strip query + hash + trailing slash (canonical = no slash
  // for non-root paths; matches how the Mongo sitemap is generated).
  const pathname = (rawPath || '/').split(/[?#]/)[0] || '/';
  let normalised = pathname.replace(/\/+$/, '') || '/';

  // Don't try to inject metadata for static asset requests, API calls
  // or files with extensions — those don't go through the SPA.
  if (/\.[a-z0-9]+$/i.test(normalised) || normalised.startsWith('/api/')) {
    return null;
  }

  let meta = null;
  if (EXACT[normalised]) {
    meta = { ...EXACT[normalised] };
  } else {
    for (const p of PREFIXES) {
      const m = normalised.match(p.pattern);
      if (m) { meta = p.build(m); break; }
    }
  }
  if (!meta) meta = { ...FALLBACK };

  meta.canonical = `${SITE_URL}${normalised === '/' ? '/' : normalised}`;

  // ─────────────────────────────────────────────────────────────────
  // DYNAMIC OVERRIDES — per-URL repairs from the SEO Auto-Fixer.
  // The Self-Crawler finds issues (duplicate title, missing JSON-LD,
  // missing description) and the Auto-Fixer writes a per-URL fix into
  // `db.seo_overrides`. server-seo-overrides.js polls /api/seo/overrides
  // every 5 min; we merge the override on top of the baseline so live
  // fixes ship without a code deploy. (Added 12 May 2026 after admin
  // categorical mandate: SEO must self-fix, not just self-audit.)
  // ─────────────────────────────────────────────────────────────────
  try {
    const { getOverrideForPath, isNoindexPath } = require('./server-seo-overrides');
    const ov = getOverrideForPath(normalised);
    if (ov) {
      if (ov.title) meta.title = ov.title;
      if (ov.description) meta.description = ov.description;
      if (ov.canonical) meta.canonical = ov.canonical;
      if (ov.jsonld) meta.jsonld = ov.jsonld;
      meta.override_applied = ov.auto_fix_reason || true;
    }
    if (isNoindexPath(normalised)) {
      meta.noindex = true;
    }
  } catch (_e) {
    // server-seo-overrides isn't ready / not running yet — graceful fall-through
  }

  return meta;
}

/**
 * Inject the resolved SEO meta tags into a CRA index.html string.
 *
 * Replaces (or appends, if missing) <title>, <meta name="description">,
 * <link rel="canonical">, and an OG basics block. Idempotent — safe
 * to call on already-augmented HTML.
 */
function injectMeta(html, meta) {
  const escapeHtml = (s) =>
    String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

  // 17 May 2026 — Fix Ahrefs "Multiple title tags / Multiple meta description tags" (62 pages each).
  //
  // The bug chain:
  //   1. We inject `<title>`, `<meta description>`, og:*, twitter:*, etc.
  //      here at SSR time (so non-JS crawlers like Googlebot's static
  //      fetcher see them).
  //   2. After hydration, `<SeoHead/>` (used on ~62 product/collection
  //      pages) ALSO injects the same tag types via React 19's auto
  //      head hoisting — without knowing the SSR copies exist.
  //   3. JS-rendering crawlers (Ahrefs, Screaming Frog with JS on)
  //      see BOTH = "Multiple title tags" alert.
  //
  // Fix: stamp every SSR-injected SEO tag with `data-ssr-seo="1"`, then
  // emit a small inline script (runs before React's bundle) that
  // removes those marked tags from <head>. Non-JS bots never reach the
  // script so they keep the SSR tags; JS bots run the script and end up
  // with React-managed tags as the single source of truth.
  const ssrAttr = ' data-ssr-seo="1"';
  const tags = [
    `<title${ssrAttr}>${escapeHtml(meta.title)}</title>`,
    `<meta name="description" content="${escapeHtml(meta.description)}"${ssrAttr} />`,
    `<link rel="canonical" href="${escapeHtml(meta.canonical)}"${ssrAttr} />`,
    `<meta property="og:title" content="${escapeHtml(meta.title)}"${ssrAttr} />`,
    `<meta property="og:description" content="${escapeHtml(meta.description)}"${ssrAttr} />`,
    `<meta property="og:url" content="${escapeHtml(meta.canonical)}"${ssrAttr} />`,
    `<meta property="og:site_name" content="${BRAND}"${ssrAttr} />`,
    `<meta property="og:type" content="${meta.product ? 'product' : 'website'}"${ssrAttr} />`,
    `<meta name="twitter:card" content="summary_large_image"${ssrAttr} />`,
    `<meta name="twitter:title" content="${escapeHtml(meta.title)}"${ssrAttr} />`,
    `<meta name="twitter:description" content="${escapeHtml(meta.description)}"${ssrAttr} />`,
  ];

  // ── Pinterest Rich Pins ──────────────────────────────────────────────
  // When the page is a product PDP we emit Pinterest's preferred Open
  // Graph "product" tags: og:image, og:image:alt, product:price:amount,
  // product:price:currency, product:availability, og:brand. Pinterest
  // reads these on any pin saved from your site and shows them as a
  // mini e-commerce card (live price + stock + brand). No API approval
  // needed for this — Pinterest scrapes the page server-side after
  // you've claimed your domain at pinterest.com/business/claim.
  // Enable "rich pin" globally so even non-product pages get richer cards.
  tags.push(`<meta name="pinterest-rich-pin" content="true" />`);
  if (meta.product) {
    const p = meta.product;
    if (p.image) {
      tags.push(`<meta property="og:image" content="${escapeHtml(p.image)}" />`);
      tags.push(`<meta property="og:image:alt" content="${escapeHtml(p.name || meta.title)}" />`);
      tags.push(`<meta name="twitter:image" content="${escapeHtml(p.image)}" />`);
    }
    if (p.price) {
      tags.push(`<meta property="product:price:amount" content="${escapeHtml(p.price)}" />`);
      tags.push(`<meta property="product:price:currency" content="${escapeHtml(p.currency || 'GBP')}" />`);
      // Pinterest-specific aliases (some scrapers read og:price:* too)
      tags.push(`<meta property="og:price:amount" content="${escapeHtml(p.price)}" />`);
      tags.push(`<meta property="og:price:currency" content="${escapeHtml(p.currency || 'GBP')}" />`);
    }
    tags.push(`<meta property="product:availability" content="${escapeHtml(p.availability || 'in stock')}" />`);
    tags.push(`<meta property="product:brand" content="${escapeHtml(p.brand || BRAND)}" />`);
    if (p.retailerItemId) {
      tags.push(`<meta property="product:retailer_item_id" content="${escapeHtml(p.retailerItemId)}" />`);
    }
  }
  // ── Pinterest domain verification ────────────────────────────────────
  // Users add their site to pinterest.com/business/claim and Pinterest
  // gives a single string ("pinterest-site-verification") to paste here.
  // We pull it from the build-time env var so a 30-sec deploy unblocks
  // domain claiming end-to-end.
  if (process.env.PINTEREST_DOMAIN_VERIFICATION) {
    tags.push(`<meta name="p:domain_verify" content="${escapeHtml(process.env.PINTEREST_DOMAIN_VERIFICATION)}" />`);
  }
  if (meta.noindex) {
    tags.push(`<meta name="robots" content="noindex, follow" />`);
  }
  // Stealth keywords — supplier-original product names like "Opal",
  // "LP-6611" etc. Indexed by Google + Bing as a `keywords` meta tag
  // and by Open Graph crawlers as `product:alternateName`. Hidden
  // from the customer-facing UI entirely (the React SPA never reads
  // these tags). Multiple alternate names are emitted as separate
  // og:product tags so each one is independently indexable.
  if (Array.isArray(meta.stealthKeywords) && meta.stealthKeywords.length > 0) {
    const csv = meta.stealthKeywords.join(', ');
    tags.push(`<meta name="keywords" content="${escapeHtml(csv)}" />`);
    for (const alt of meta.stealthKeywords) {
      tags.push(`<meta property="product:alternateName" content="${escapeHtml(alt)}" />`);
    }
  }
  // Optional Schema.org JSON-LD for rich results (Products, Collections).
  // Embedded as a single <script> block so Google's parser picks it up
  // alongside the meta tags. Newlines stripped to keep the HTML compact.
  if (meta.jsonld) {
    const json = JSON.stringify(meta.jsonld)
      .replace(/</g, '\\u003c')  // safe inside <script>
      .replace(/-->/g, '--\\>');
    tags.push(`<script type="application/ld+json"${ssrAttr}>${json}</script>`);
  }

  // 17 May 2026 — every pushed SEO tag must carry the data-ssr-seo marker
  // so the inline strip-on-mount script in <body> can find and remove
  // them before React mounts (avoiding the duplicate-tag bug). The
  // first 11 tags above already include the attribute; here we patch
  // anything pushed AFTER the initial block (og:image, og:price,
  // product:availability, pinterest-rich-pin, robots, keywords, etc.)
  // by appending the attribute to any tag that doesn't already have it.
  for (let i = 0; i < tags.length; i++) {
    const tag = tags[i];
    if (!tag.includes('data-ssr-seo')) {
      // Insert before the closing /> or > of the opening tag.
      tags[i] = tag.replace(/(\s*\/?>)/, `${ssrAttr}$1`);
    }
  }

  const block = `\n        <!-- SSR-injected SEO (server.js) -->\n        ${tags.join('\n        ')}\n        <!-- /SSR-injected SEO -->\n`;

  // 17 May 2026 — REVERTED the inline strip-on-mount approach (took down
  // 77 pages' title tags on production for ~1 hour). The plan was:
  //   1. mark every SSR SEO tag with data-ssr-seo="1"
  //   2. emit an inline script that runs before React mounts and strips
  //      those tags so <SeoHead/> can be the single source of truth
  //
  // What actually happened: on 77 collection/category pages, <SeoHead/>
  // either isn't rendered at all OR mounts after a slow API fetch.
  // Result: strip script ran, removed the title — and nothing replaced
  // it. Ahrefs reported "Title tag missing" on 77 pages and the Health
  // Score dropped 90s → 63 within one crawl.
  //
  // Lesson: duplicate <title>/<meta> tags are a WARNING on Ahrefs. A
  // missing title is a critical ERROR that tanks indexing. The cure
  // was worse than the disease. We keep the data-ssr-seo markers (they
  // cost nothing and are useful for future per-page cleanups) but the
  // strip script is removed entirely.
  //
  // Proper fix for the duplicate-tags issue lives inside <SeoHead/>
  // itself — it should clean up matching SSR tags before injecting its
  // own. Tracked in /app/memory/PRD.md.
  const blockWithStripper = block;

  // Strip any previously-injected block + its strip script (idempotency
  // on rebuilds). We do this in TWO passes to avoid a regex that has to
  // match both with optional whitespace — non-greedy quantifiers were
  // unreliable when the strip <script> appeared after a blank line.
  let out = html.replace(
    /\n?\s*<!-- SSR-injected SEO[\s\S]*?<!-- \/SSR-injected SEO -->\n?/,
    '',
  );
  // Then strip any leftover SEO strip script from a previous injection.
  // Keyed on the unique `__seoSsrStripped` flag so we don't nuke
  // unrelated <script> tags.
  out = out.replace(
    /\n?\s*<script>\(function\(\)\{try\{if\(window\.__seoSsrStripped\)[\s\S]*?<\/script>\n?/,
    '',
  );
  // Insert just before </head>
  if (out.includes('</head>')) {
    out = out.replace('</head>', `${blockWithStripper}    </head>`);
  } else {
    // No </head>? Append block at the end (defensive — should never happen)
    out = out + blockWithStripper;
  }

  // ─────────────────────────────────────────────────────────────────
  // SSR body content injection (12 May 2026 — GSC Soft 404 hotfix)
  // ─────────────────────────────────────────────────────────────────
  // GSC reported 90 "Soft 404" + 102 "Crawled - currently not indexed"
  // pages. Root cause: Googlebot fetched our pages and saw an empty
  // <div id="root"></div> — no H1, no paragraph, no readable text —
  // so it concluded the page had no content (= soft 404).
  //
  // Fix: inject a real <h1> + description paragraph + a "Loading…"
  // skeleton inside <div id="root">. React's createRoot().render()
  // REPLACES the entire root contents on first paint, so:
  //   • Crawlers (no JS) see real readable content → indexable
  //   • Real users never see this — React swaps it out instantly
  //   • Skipped when meta.noindex is true — no point ranking those
  //
  // We only emit when the SPA shell has a literal empty root div
  // (`<div id="root"></div>`), so we don't trample any future
  // server-rendered content the build pipeline might add later.
  if (!meta.noindex) {
    const heading = escapeHtml(meta.title || '');
    const paragraph = escapeHtml(meta.description || '');
    // 13 May 2026 — UX fix. Previously the SSR fallback (H1 + nav +
    // "Loading the full storefront…") was *visually* shown while React
    // hydrated. On slow connections / large bundles users saw it for
    // 10+ seconds and thought the site was broken.
    //
    // New approach:
    //   * Off-screen-position the fallback (`.ssr-fallback`) so it stays
    //     in the DOM (crawlers + screen readers still find it → no SEO
    //     regression on Soft 404s / outgoing-links audits)
    //   * Show a tiny brand-coloured spinner in its place so real users
    //     get a clean "this is loading" signal instead of broken-looking
    //     skeleton text
    //
    // 12 May 2026 — added internal navigation links to fix Ahrefs
    // "Page has no outgoing links" on 20 URLs. Every SSR-rendered
    // page now has at least 8 outgoing internal links visible to
    // crawlers, so no page is a "dead end" pre-hydration.
    const navLinks = (
      `<nav style="font-size:0.875rem;color:#374151;line-height:2;border-top:1px solid #e5e7eb;border-bottom:1px solid #e5e7eb;padding:16px 0;margin:24px 0;">` +
        `<a href="/" style="color:#1f2937;margin-right:20px;text-decoration:underline;">Home</a>` +
        `<a href="/tiles" style="color:#1f2937;margin-right:20px;text-decoration:underline;">Shop all tiles</a>` +
        `<a href="/collections" style="color:#1f2937;margin-right:20px;text-decoration:underline;">Collections</a>` +
        `<a href="/clearance" style="color:#1f2937;margin-right:20px;text-decoration:underline;">Clearance</a>` +
        `<a href="/new-collection" style="color:#1f2937;margin-right:20px;text-decoration:underline;">New arrivals</a>` +
        `<a href="/shop/bathroom" style="color:#1f2937;margin-right:20px;text-decoration:underline;">Bathroom tiles</a>` +
        `<a href="/shop/info/faq" style="color:#1f2937;margin-right:20px;text-decoration:underline;">FAQ</a>` +
        `<a href="/shop/info/delivery" style="color:#1f2937;margin-right:20px;text-decoration:underline;">Delivery</a>` +
        `<a href="/shop/info/returns" style="color:#1f2937;margin-right:20px;text-decoration:underline;">Returns</a>` +
        `<a href="/shop/info/about" style="color:#1f2937;margin-right:20px;text-decoration:underline;">About us</a>` +
        `<a href="/shop/contact" style="color:#1f2937;text-decoration:underline;">Contact</a>` +
      `</nav>`
    );
    // Crawler-only content: off-screen for sighted users, still in DOM
    // for Googlebot/Bingbot/Ahrefs/Screaming Frog/screen readers.
    // `clip` + `clip-path` is the universally-accepted "visually hidden
    // but available to assistive tech" pattern (used by GOV.UK,
    // tailwind's `.sr-only`, react-aria, etc.).
    const offScreenStyle = (
      `position:absolute;width:1px;height:1px;padding:0;margin:-1px;` +
      `overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0;`
    );
    // Visible-to-users loading indicator. Pure CSS keyframe spinner so
    // it works pre-hydration. Sized small (32×32) and centred low on
    // the page so it doesn't dominate the viewport.
    const spinnerStyle = (
      `<style>` +
        `@keyframes ts-spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}` +
        `.ts-ssr-spinner{position:fixed;left:50%;top:50%;margin:-16px 0 0 -16px;` +
        `width:32px;height:32px;border:3px solid #e5e7eb;border-top-color:#1f2937;` +
        `border-radius:50%;animation:ts-spin .8s linear infinite;z-index:1;}` +
        // React mounts and replaces #root contents → spinner is unmounted
        // automatically because it lives inside #root.
      `</style>`
    );
    const bodyBlock = (
      spinnerStyle +
      // The SSR content is positioned off-screen so users never see it
      // while React boots. Crawlers still see it (it's in the DOM).
      `<div class="ssr-fallback" style="${offScreenStyle}">` +
        `<h1>${heading}</h1>` +
        `<p>${paragraph}</p>` +
        navLinks +
      `</div>` +
      // Visible spinner — replaced by React on mount.
      `<div class="ts-ssr-spinner" aria-hidden="true"></div>`
    );
    out = out.replace(
      /(<div id="root">)\s*(<\/div>)/,
      `$1${bodyBlock}$2`,
    );
  }

  return out;
}

module.exports = { resolveSeo, injectMeta, EXACT, PREFIXES, FALLBACK };
