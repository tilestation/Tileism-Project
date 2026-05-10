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
  description: 'UK tile and stone specialist with three showrooms across Kent and Essex.',
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
    title: `${BRAND} — Premium Tiles & Stone, UK Showrooms in Tonbridge, Chingford & Gravesend`,
    description: 'UK tile specialists with three showrooms across Kent and Essex. Browse 1,000+ porcelain, marble, terrazzo and stone tiles with free samples and trade pricing.',
    jsonld: { '@context': 'https://schema.org', '@graph': [ORG_JSONLD, WEBSITE_JSONLD] },
  },
  '/tiles': {
    title: `Shop All Tiles · ${BRAND}`,
    description: 'Browse our full range of porcelain, marble, terrazzo, stone and ceramic tiles. Free samples, trade prices, fast UK delivery.',
  },
  '/collections': {
    title: `Tile Collections · ${BRAND}`,
    description: 'Explore curated tile collections by style, room and finish. Spanish floor tiles, Italian marble, terrazzo, large-format slabs and more.',
  },
  '/about': {
    title: `About ${BRAND} — UK Tile Specialists Since 1985`,
    description: 'Family-run tile and stone supplier with three Kent and Essex showrooms. Trade and retail customers welcome.',
  },
  '/contact': {
    title: `Contact ${BRAND} — Showroom Locations & Trade Enquiries`,
    description: 'Visit our Tonbridge, Chingford or Gravesend showrooms, or get in touch with our trade team for project quotes.',
  },
  '/showrooms': {
    title: `Tile Showrooms in Tonbridge, Chingford & Gravesend · ${BRAND}`,
    description: 'Visit one of our three UK tile showrooms — see thousands of tiles in person, take home free samples, and chat to our specialists.',
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
  '/blog': { title: `Tile & Stone Blog · ${BRAND}`, description: 'Tile guides, design inspiration, installation tips and supplier news from the Tile Station team.' },
  '/faq': { title: `FAQ · ${BRAND}`, description: 'Answers to the most common tile, stone, sample and delivery questions.' },
  '/delivery': { title: `Delivery & Returns · ${BRAND}`, description: 'How we deliver tiles across the UK, lead times, returns and breakage policy.' },
  '/privacy': { title: `Privacy Policy · ${BRAND}`, description: 'How Tile Station handles your data. GDPR-compliant.' },
  '/terms': { title: `Terms & Conditions · ${BRAND}`, description: 'Tile Station terms of sale, returns and warranties.' },
  '/status': { title: `System Status · ${BRAND}`, description: 'Live status of our storefront, sample ordering and delivery systems.' },
  '/visualizer': { title: `Tile Visualizer (Coming Soon) · ${BRAND}`, description: 'See real tiles in your own room photo before you buy. Join the early-access waitlist.' },
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
];

const FALLBACK = {
  title: `${BRAND} — Premium Tiles & Stone, UK`,
  description: 'UK tile specialists with three showrooms. Browse 1,000+ porcelain, marble, terrazzo and stone tiles.',
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

  const tags = [
    `<title>${escapeHtml(meta.title)}</title>`,
    `<meta name="description" content="${escapeHtml(meta.description)}" />`,
    `<link rel="canonical" href="${escapeHtml(meta.canonical)}" />`,
    `<meta property="og:title" content="${escapeHtml(meta.title)}" />`,
    `<meta property="og:description" content="${escapeHtml(meta.description)}" />`,
    `<meta property="og:url" content="${escapeHtml(meta.canonical)}" />`,
    `<meta property="og:site_name" content="${BRAND}" />`,
    `<meta property="og:type" content="${meta.product ? 'product' : 'website'}" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:title" content="${escapeHtml(meta.title)}" />`,
    `<meta name="twitter:description" content="${escapeHtml(meta.description)}" />`,
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
    tags.push(`<script type="application/ld+json">${json}</script>`);
  }
  const block = `\n        <!-- SSR-injected SEO (server.js) -->\n        ${tags.join('\n        ')}\n        <!-- /SSR-injected SEO -->\n`;

  // Strip any previously-injected block (idempotency on rebuilds)
  let out = html.replace(
    /\n?\s*<!-- SSR-injected SEO[\s\S]*?<!-- \/SSR-injected SEO -->\n?/,
    '',
  );
  // Insert just before </head>
  if (out.includes('</head>')) {
    out = out.replace('</head>', `${block}    </head>`);
  } else {
    // No </head>? Append block at the end (defensive — should never happen)
    out = out + block;
  }
  return out;
}

module.exports = { resolveSeo, injectMeta, EXACT, PREFIXES, FALLBACK };
