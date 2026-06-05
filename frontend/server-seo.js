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

// 5 Jun 2026 — switched default canonical host to `www.` after Ahrefs
// flagged the homepage as "Non-canonical page receives organic
// traffic" (47 inlinks + ranking #4 for "tiles tonbridge" on the www
// version, while canonical pointed at non-www). Single source of
// truth — mirrored in SeoHead.jsx, server.js (PUBLIC_SITE_URL), and
// backend routes/seo_public.py (_canonical_host).
const SITE_URL = process.env.PUBLIC_SITE_URL || 'https://www.tilestation.co.uk';
const BRAND = 'Tile Station';

// Prettify a slug like "spanish-floor-tiles-60x60" → "Spanish Floor Tiles 60x60"
const titleCase = (slug) => {
  if (!slug) return '';
  return slug
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (m) => m.toUpperCase())
    .trim();
};

// ─── Length-clamp helpers ───────────────────────────────────────────
// Ahrefs flags <title> > 60 chars and <meta description> > 160 chars.
// Long dynamic slugs (e.g. "grey-marble-effect-large-format-floor-tiles")
// would otherwise blow past both limits. These helpers truncate the
// dynamic portion at a word boundary so the final tag stays compliant.
//
// Added 24 Feb 2026 — was responsible for ~74 "Title too long" + ~45
// "Description too long" alerts on the Feb crawl. The actual brand
// suffix (` · Tile Station`) is always preserved.
const clampTitle = (text, max = 60) => {
  if (!text || text.length <= max) return text;
  // Truncate at last space before the limit, fall back to hard cut.
  const cut = text.lastIndexOf(' ', max);
  return (cut > 20 ? text.slice(0, cut) : text.slice(0, max)).trimEnd();
};
const clampDesc = (text, max = 158) => {
  if (!text || text.length <= max) return text;
  const cut = text.lastIndexOf(' ', max);
  return (cut > 60 ? text.slice(0, cut) : text.slice(0, max)).trimEnd();
};
// Build a title in the form `<Subject><Suffix>` that fits within 60
// chars total. If <Subject> is too long it gets clamped so the suffix
// always survives intact (preserves brand visibility in SERPs).
const buildClampedTitle = (subject, suffix) => {
  const suf = suffix || '';
  const max = 60 - suf.length;
  const sub = clampTitle(subject || '', Math.max(20, max));
  return `${sub}${suf}`;
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
    // 17 May 2026 — Trimmed title 117 → 60 chars and description 199 → 155
    // to satisfy Ahrefs "Title too long" + "Meta description too long" alerts.
    // Showroom list moved to JSON-LD (still indexed) so we don't lose the
    // local-SEO keywords entirely.
    title: `${BRAND} — Premium Tiles, Bathrooms & Flooring UK`,
    description: 'UK tile, bathroom & flooring specialists with four showrooms across Kent, Essex & London. 1,000+ porcelain, marble, terrazzo & wood. Free samples.',
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
    description: 'Family-run tile and stone supplier with four UK showrooms — Tonbridge, Chingford, Gravesend and Sydenham. Trade and retail customers welcome.',
  },
  '/contact': {
    title: `Contact ${BRAND} — Showroom Locations & Trade Enquiries`,
    description: 'Visit our Tonbridge, Chingford, Gravesend or Sydenham showrooms, or contact our trade team for project quotes, samples and UK-wide delivery pricing.',
  },
  '/showrooms': {
    // 17 May 2026 — Title was 78 chars (over 60-char limit). Shortened.
    title: `Tile Showrooms in Kent, Essex & London · ${BRAND}`,
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
  '/wishlist': { title: `Your Wishlist · ${BRAND}`, description: 'Tiles you\'ve saved to your wishlist. Sign in to sync across devices, share with friends or family, and order free samples.', noindex: true },
  '/basket': { title: `Your Basket · ${BRAND}`, description: 'Your tile basket and order summary. Apply promo codes, choose delivery, and proceed to secure checkout.', noindex: true },
  '/checkout': { title: `Checkout · ${BRAND}`, description: 'Complete your tile order — secure UK checkout with card, Apple Pay, Google Pay or trade account. Tracked delivery on every order.', noindex: true },
  '/account': { title: `My Account · ${BRAND}`, description: 'Manage your Tile Station account, orders, addresses, samples and trade application status. UK customer support team available.', noindex: true },
  '/login': { title: `Sign In · ${BRAND}`, description: 'Sign in to your Tile Station account to view orders, track samples and access your wishlist. Faster checkout for returning customers.', noindex: true },
  '/register': { title: `Create Account · ${BRAND}`, description: 'Create a Tile Station account for faster checkout, saved samples, order tracking and exclusive offers across our UK tile range.', noindex: true },
  '/trade': { title: `Trade Account · ${BRAND}`, description: 'Apply for a Tile Station trade account — exclusive pricing, 30-day credit terms and priority service for installers, contractors and developers across the UK.' },
  '/blog': { title: `Blog · ${BRAND}`, description: 'Tile, bathroom and flooring guides, design inspiration, installation tips and supplier news from the Tile Station team. New articles every week.' },
  '/faq': { title: `FAQ · ${BRAND}`, description: 'Answers to the most common tile, stone, sample and delivery questions — orders, returns, trade accounts, breakage cover and showroom collection.' },
  '/delivery': { title: `Delivery & Returns · ${BRAND}`, description: 'How we deliver tiles across the UK — pallet service, kerbside drop, lead times, breakage cover, returns and damaged-on-arrival claims policy.' },
  '/privacy': { title: `Privacy Policy · ${BRAND}`, description: 'How Tile Station handles your personal data — GDPR-compliant cookies, marketing, order data, customer accounts and your subject-access rights.' },
  '/terms': { title: `Terms & Conditions · ${BRAND}`, description: 'Tile Station terms and conditions of sale — warranties, returns, payment, delivery and trade-account terms for UK retail and trade customers.' },
  '/status': { title: `System Status · ${BRAND}`, description: 'Live status of our storefront, sample ordering, payment, delivery and showroom-collection systems. Real-time incidents and uptime history.' },
  '/visualizer': { title: `Tile Visualizer (Coming Soon) · ${BRAND}`, description: 'See real tiles in your own room photo before you buy — early-access waitlist for the Tile Station room visualizer. Free for all customers at launch.' },

  // ───────────────────────────────────────────────────────────────
  // 13 May 2026 — added /clearance + /new-collection EXACT rules so
  // they get unique, descriptive titles instead of falling through to
  // FALLBACK (which is brand-only). Both are in sitemap.xml so Google
  // indexes them; unique titles avoid the duplicate-title cluster.
  // ───────────────────────────────────────────────────────────────
  '/clearance': {
    // 24 Feb 2026 — Title was 66 chars (over Ahrefs 60-char limit), description 163 chars (over 160). Both shortened.
    title: `Tile & Bathroom Clearance — Up to 70% Off · ${BRAND}`,
    description: 'Last-chance deals on porcelain, marble, terrazzo, vinyl and engineered wood. Discontinued lines and end-of-roll stock — while supplies last.',
  },
  '/new-collection': {
    // 24 Feb 2026 — Title was 67 chars. Shortened.
    title: `New Tile & Flooring Collections · ${BRAND}`,
    description: 'Browse the latest arrivals — new porcelain, marble, terrazzo, vinyl plank and engineered wood ranges added this season. Free UK samples available.',
  },

  // ─────────────────────────────────────────────────────────────────
  // /shop/* exact pages — added 12 May 2026 after Ahrefs flagged 15
  // "Title tag missing or empty" URLs (all returning the FALLBACK
  // generic title because /shop/* never matched any rule). These give
  // every shop-side static page a unique, indexable title.
  // ─────────────────────────────────────────────────────────────────
  '/shop/faq': { title: `FAQ · ${BRAND}`, description: 'Tile & stone FAQs — orders, samples, returns, trade accounts, delivery and installation.' },
  '/shop/sample-service': { title: `Tile Sample Service · ${BRAND}`, description: 'Order tile samples by post and see them in your own light before buying. £2.99 P&P, refunded on purchase. Touch, feel and compare in your space.' },
  '/shop/tile-forgot-password': { title: `Reset Your Password · ${BRAND}`, description: 'Reset the password for your Tile Station account — enter your email and we\'ll send a secure reset link in seconds.', noindex: true },
  '/shop/tile-login': { title: `Sign In · ${BRAND}`, description: 'Sign in to your Tile Station account to view orders, samples, wishlists and trade pricing across our full UK tile range.', noindex: true },
  '/shop/tile-register': { title: `Create Account · ${BRAND}`, description: 'Create a Tile Station account for faster checkout, saved samples, order tracking and exclusive offers across our UK tile and flooring range.', noindex: true },
  '/shop/tile-cart': { title: `Your Basket · ${BRAND}`, description: 'Your tile basket and order summary. Apply promo codes, choose delivery and proceed to secure UK checkout.', noindex: true },
  '/shop/cart': { title: `Your Basket · ${BRAND}`, description: 'Your tile basket and order summary. Apply promo codes, choose delivery and proceed to secure UK checkout.', noindex: true },
  '/shop/checkout': { title: `Secure Checkout · ${BRAND}`, description: 'Complete your tile order with secure UK checkout — card, Apple Pay, Google Pay or trade account. Tracked delivery on every order.', noindex: true },
  '/shop/account': { title: `My Account · ${BRAND}`, description: 'Manage your Tile Station orders, samples, saved addresses and trade-application status. UK customer support team available.', noindex: true },
  '/shop/orders': { title: `My Orders · ${BRAND}`, description: 'View and track your Tile Station orders, download invoices, reorder favourites and request samples again.', noindex: true },
  '/shop/track': { title: `Track Your Order · ${BRAND}`, description: 'Track your Tile Station order with your order number and email. Live pallet courier updates, ETA windows and damaged-on-arrival claims.' },
  '/shop/trade/register': { title: `Trade Account Application · ${BRAND}`, description: 'Apply for a Tile Station trade account — exclusive pricing, 30-day credit and priority service for installers, contractors and developers.' },
  '/shop/trade/account': { title: `Trade Account · ${BRAND}`, description: 'Your Tile Station trade account dashboard — exclusive trade pricing, 30-day credit terms, invoice history and project tracking.', noindex: true },
  '/shop/bathroom': { title: `Bathroom Tiles & Inspiration · ${BRAND}`, description: 'Bathroom tile ideas, designer inspiration and our complete bathroom tile range — porcelain, marble, terrazzo and large-format slabs for walls and floors.' },
  // 24 Feb 2026 — Title was 83 chars (over Ahrefs 60-char limit). Shortened; showroom list now lives in the meta description and Organization JSON-LD.
  '/shop/contact': { title: `Contact Us · ${BRAND} Tile Showrooms`, description: 'Visit our Tonbridge, Chingford, Gravesend or Sydenham tile showrooms, or contact our trade team for project quotes and UK-wide delivery pricing.' },
  '/shop/refer': { title: `Refer a Friend & Earn £25 Credit · ${BRAND}`, description: 'Recommend Tile Station to a friend and you both earn £25 credit on your next tile order. Unlimited referrals, full UK tile range eligible.' },
  '/shop/compare': { title: `Compare Tiles Side-by-Side · ${BRAND}`, description: 'Compare up to 4 tiles side-by-side — price, size, material, finish, stock status and delivery time. Make a confident choice before ordering.' },
  '/shop/all-tiles': { title: `All Tiles · ${BRAND}`, description: 'Browse our complete UK range — 1,000+ porcelain, marble, terrazzo, ceramic, vinyl and engineered wood tiles. Free samples and trade pricing.' },
  '/shop/tiles': { title: `Shop Tiles · ${BRAND}`, description: 'Browse our tile range by material, size, finish and room. Free UK samples, trade pricing, fast pallet delivery and showroom collection available.' },
  '/shop/order-success': { title: `Order Confirmed · ${BRAND}`, description: 'Thank you — your Tile Station order has been confirmed. Track your delivery and view your invoice in your account.', noindex: true },
  '/shop/wishlist': { title: `Your Wishlist · ${BRAND}`, description: 'Tiles you\'ve saved for later. Sign in to sync your wishlist across devices, share with friends or family, and order free samples.', noindex: true },
  '/shop/tile-samples': { title: `Order Tile Samples · ${BRAND}`, description: 'Touch, feel and compare tiles in your own light before buying. Sample postage £2.99, refunded on every purchase. UK-wide delivery in 3-5 days.' },
  '/shop/tile-sample-success': { title: `Sample Order Confirmed · ${BRAND}`, description: 'Thanks — your tile samples are on their way. Most UK addresses receive samples in 3-5 working days.', noindex: true },
  '/shop/contact-us': { title: `Contact Us · ${BRAND}`, description: 'Get in touch with the Tile Station team — four UK tile showrooms across Kent, Essex and London plus a trade and customer-service team.' },
  '/shop/stores': { title: `Visit a Showroom · ${BRAND}`, description: 'Visit our Tonbridge, Chingford, Gravesend or Sydenham tile showrooms — opening hours, addresses, parking info and same-day showroom collection.' },
  // 17 May 2026 — Ahrefs flagged these meta descriptions as too short
  // (<120 chars). Expanded all of them to ~140-160 chars with real
  // shopper-intent keywords (tracking, refunds, GDPR, T&Cs etc.) so
  // they pass both the length check AND give Google something useful
  // to display in the search snippet.
  '/shop/info/faq': { title: `FAQ · ${BRAND}`, description: 'Tile and stone FAQs — answers on orders, samples, returns, trade accounts, delivery lead times and tile installation. UK customer support.' },
  '/shop/info/privacy': { title: `Privacy Policy · ${BRAND}`, description: 'How Tile Station handles your personal data — GDPR-compliant policy covering cookies, marketing, order data, customer accounts and your rights.' },
  '/shop/info/terms': { title: `Terms & Conditions · ${BRAND}`, description: 'Tile Station terms and conditions of sale — warranties, returns, payment terms, delivery agreements and trade account terms for UK customers.' },
  '/shop/info/returns': { title: `Returns & Refunds · ${BRAND}`, description: 'Tile Station returns and refunds policy — easy 30-day returns on standard stock, refund timelines, breakage cover and damaged-on-arrival claims.' },
  '/shop/info/delivery': { title: `Delivery Information · ${BRAND}`, description: 'Tile Station UK delivery — next-day & nationwide pallet service, tracking, lead times, breakage cover, kerbside drop and showroom collection.' },
  '/shop/info/reviews': { title: `Customer Reviews · ${BRAND}`, description: 'Real verified customer reviews of Tile Station tiles, samples, delivery and showroom visits across Tonbridge, Chingford, Gravesend and Sydenham.' },
  '/shop/info/about': { title: `About ${BRAND}`, description: 'Family-run UK tile and stone specialist with four Kent, Essex and London showrooms — Tonbridge, Chingford, Gravesend and Sydenham. Trade and retail welcome.' },
  '/shop/info/sample-service': { title: `Sample Service · ${BRAND}`, description: 'How our £2.99 tile sample service works — refunded on every purchase, UK-wide delivery in 3-5 days, touch and feel before committing to a full order.' },

  // 15 May 2026 — Ahrefs flagged the bare `/shop/<page>` paths as
  // duplicate-without-canonical because they were falling back to the
  // generic brand meta. These mirror the `/shop/info/<page>` variants
  // so both URLs serve the right title/description regardless of
  // which route a customer (or crawler) hits.
  '/shop/delivery': { title: `Delivery Information · ${BRAND}`, description: 'Tile Station UK delivery — next-day & nationwide pallet service, tracking, lead times, breakage cover, kerbside drop and showroom collection.' },
  '/shop/returns': { title: `Returns & Refunds · ${BRAND}`, description: 'Tile Station returns and refunds policy — easy 30-day returns on standard stock, refund timelines, breakage cover and damaged-on-arrival claims.' },
  '/shop/about': { title: `About ${BRAND}`, description: 'Family-run UK tile and stone specialist with four Kent, Essex and London showrooms — Tonbridge, Chingford, Gravesend and Sydenham. Trade and retail welcome.' },

  // ─────────────────────────────────────────────────────────────────
  // 24 Feb 2026 — Ahrefs "duplicate title" cluster fix. The 22 routes
  // below previously fell through to FALLBACK (= shared the brand-only
  // title with 1000+ other URLs). Each now has a unique, indexable
  // title — and transactional/account-management pages get `noindex`
  // so we don't compete with our own product pages for SERP space.
  // ─────────────────────────────────────────────────────────────────
  '/forgot-password': { title: `Reset Your Password · ${BRAND}`, description: 'Reset the password for your Tile Station account — enter your email and we\'ll send a secure password-reset link within seconds.', noindex: true },
  '/reset-password': { title: `Set a New Password · ${BRAND}`, description: 'Choose a new password for your Tile Station account. Strong passwords keep your orders, samples and trade pricing secure.', noindex: true },
  '/unsubscribe': { title: `Unsubscribe · ${BRAND}`, description: 'Manage your email preferences or unsubscribe from Tile Station marketing communications. Your transactional order updates will continue.', noindex: true },
  '/customer/dashboard': { title: `Customer Dashboard · ${BRAND}`, description: 'Your customer dashboard — track orders, manage samples, save tiles to your wishlist and view your trade-account status.', noindex: true },
  '/customer/orders': { title: `My Orders · ${BRAND}`, description: 'View and track your Tile Station orders, download invoices, request samples again and reorder favourites.', noindex: true },
  '/shop/products': { title: `Browse Tiles · ${BRAND}`, description: 'Browse the complete Tile Station UK tile range — porcelain, marble, terrazzo, ceramic, vinyl and engineered wood across all sizes and finishes.' },
  '/shop/login': { title: `Sign In · ${BRAND}`, description: 'Sign in to your Tile Station account to view orders, samples, wishlists and trade pricing across our full UK tile and flooring range.', noindex: true },
  '/shop/register': { title: `Create Account · ${BRAND}`, description: 'Create a Tile Station account for faster checkout, saved samples, order tracking and exclusive offers across our UK tile and flooring range.', noindex: true },
  '/shop/trade/login': { title: `Trade Login · ${BRAND}`, description: 'Sign in to your Tile Station trade account — exclusive trade pricing, 30-day credit terms, invoice history and project tracking.', noindex: true },
  '/shop/tile-checkout': { title: `Secure Checkout · ${BRAND}`, description: 'Complete your tile order with secure UK checkout — card, Apple Pay, Google Pay or trade account. Tracked delivery on every order.', noindex: true },
  '/shop/tile-wishlist': { title: `Your Wishlist · ${BRAND}`, description: 'Tiles you\'ve saved for later. Sign in to sync your wishlist across devices, share with friends or family, and order free samples.', noindex: true },
  '/shop/tile-order-success': { title: `Order Confirmed · ${BRAND}`, description: 'Thank you — your Tile Station order has been confirmed. Track your pallet delivery and download your invoice from your account.', noindex: true },
  '/shop/tile-account': { title: `My Account · ${BRAND}`, description: 'Manage your Tile Station account, orders, samples, saved addresses and trade-application status. UK customer support team available.', noindex: true },
  '/shop/calculator': { title: `Tile Calculator · ${BRAND}`, description: 'Calculate how many tiles you need for your room — add wastage, choose your tile size and get a per-square-metre price estimate in seconds.' },
  '/shop/search': { title: `Search Tiles · ${BRAND}`, description: 'Search 1,000+ porcelain, marble, terrazzo, ceramic, vinyl and engineered wood tiles. Filter by size, finish, room and price.', noindex: true },
  '/showroom-signup': { title: `Showroom Newsletter Signup · ${BRAND}`, description: 'Sign up to hear about new tile collections, in-store events and seasonal offers at our Tonbridge, Chingford, Gravesend and Sydenham showrooms.' },
  '/shop/faq': { title: `FAQ · ${BRAND}`, description: 'Tile and stone FAQs — answers on orders, samples, returns, trade accounts, delivery lead times and tile installation. UK customer support.' },
  '/shop/privacy': { title: `Privacy Policy · ${BRAND}`, description: 'How Tile Station handles your personal data — GDPR-compliant policy covering cookies, marketing, order data, customer accounts and your rights.' },
  '/shop/terms': { title: `Terms & Conditions · ${BRAND}`, description: 'Tile Station terms and conditions of sale — warranties, returns, payment terms, delivery agreements and trade account terms for UK customers.' },
  '/shop/reviews': { title: `Customer Reviews · ${BRAND}`, description: 'Real verified customer reviews of Tile Station tiles, samples, delivery and showroom visits across Tonbridge, Chingford, Gravesend and Sydenham.' },
  '/shop/sample-service': { title: `Sample Service · ${BRAND}`, description: 'How our £2.99 tile sample service works — refunded on every purchase, UK-wide delivery in 3-5 days, touch and feel before committing to a full order.' },
};

// Dynamic prefix patterns — first match wins
const PREFIXES = [
  // Product detail: /tiles/:slug or /products/:slug
  {
    pattern: /^\/(?:tiles|products)\/([^/?#]+)\/?$/,
    build: (m) => {
      const name = titleCase(m[1]);
      return {
        title: buildClampedTitle(name, ` · ${BRAND}`),
        description: clampDesc(`Buy ${name} at ${BRAND} — premium UK tile supplier with four Kent, Essex and London showrooms. Free samples, trade pricing and fast UK-wide delivery.`),
      };
    },
  },
  // Collection page: /collections/:slug
  {
    pattern: /^\/collections\/([^/?#]+)\/?$/,
    build: (m) => {
      const name = titleCase(m[1]);
      return {
        title: buildClampedTitle(`${name} Collection`, ` · ${BRAND}`),
        description: clampDesc(`Explore the ${name} tile collection at ${BRAND}. Free UK samples, trade pricing and fast pallet delivery on every order — across England, Scotland and Wales.`),
      };
    },
  },
  // Category browse: /tiles/category/:slug or /tiles/:material
  {
    pattern: /^\/tiles\/category\/([^/?#]+)\/?$/,
    build: (m) => {
      const name = titleCase(m[1]);
      return {
        title: buildClampedTitle(`${name} Tiles`, ` · ${BRAND}`),
        description: clampDesc(`Shop ${name} tiles at ${BRAND} — premium UK tile retailer with four showrooms across Kent, Essex and London. Free samples, trade pricing and fast delivery.`),
      };
    },
  },
  // Local SEO pages: /tile-shop/:city, /tile-shop-near-me/:city
  {
    pattern: /^\/(?:tile-shop|tile-shop-near-me|tile-shops?)\/([^/?#]+)\/?$/,
    build: (m) => {
      const city = titleCase(m[1]);
      return {
        title: buildClampedTitle(`Tile Shop ${city}`, ` — ${BRAND} Showroom`),
        description: clampDesc(`Tile shop in ${city} — visit our showroom or browse 1,000+ porcelain, marble, terrazzo and ceramic tiles online. Free samples and fast UK delivery.`),
      };
    },
  },
  // Installer city pages: /installer/:city
  {
    pattern: /^\/installer\/([^/?#]+)\/?$/,
    build: (m) => {
      const city = titleCase(m[1]);
      return {
        title: buildClampedTitle(`Tile Installers in ${city}`, ` · ${BRAND}`),
        description: clampDesc(`Find vetted tile installers in ${city}. Compare quotes, read reviews and book your kitchen, bathroom or hallway project with ${BRAND} — UK-wide network.`),
      };
    },
  },
  // Blog post: /blog/:slug
  {
    pattern: /^\/blog\/([^/?#]+)\/?$/,
    build: (m) => {
      const name = titleCase(m[1]);
      return {
        title: buildClampedTitle(name, ` · ${BRAND} Blog`),
        description: clampDesc(`${name} — expert tile and stone advice from the ${BRAND} team. Designer inspiration, installation tips and trade-supplier news from UK specialists.`),
      };
    },
  },
  // Visualizer share: /visualizer/share/:token (no-index so just sane title)
  {
    pattern: /^\/visualizer\/share\/[^/?#]+\/?$/,
    build: () => ({
      title: `Shared Tile Visualization · ${BRAND}`,
      description: 'A shared tile visualization from Tile Station\'s room visualizer — see real tiles in a real room before you order.',
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
        title: buildClampedTitle(`${name} Collection`, ` · ${BRAND}`),
        description: clampDesc(`Explore the ${name} tile collection at ${BRAND} — free UK samples, trade pricing and fast pallet delivery. Browse the full range and order today.`),
      };
    },
  },
  // /shop/product/<slug> → "<Slug> · Tile Station"
  {
    pattern: /^\/shop\/product\/([^/?#]+)\/?$/i,
    build: (m) => {
      const name = titleCase(decodeURIComponent(m[1]));
      return {
        title: buildClampedTitle(name, ` · ${BRAND}`),
        description: clampDesc(`Buy ${name} at ${BRAND} — premium UK tile supplier with four showrooms. Free samples, trade pricing and fast pallet delivery across the UK.`),
      };
    },
  },
  // /shop/products/<slug> (legacy)
  {
    pattern: /^\/shop\/products\/([^/?#]+)\/?$/i,
    build: (m) => {
      const name = titleCase(decodeURIComponent(m[1]));
      return {
        title: buildClampedTitle(name, ` · ${BRAND}`),
        description: clampDesc(`Buy ${name} at ${BRAND} — premium UK tile supplier with four showrooms. Free samples, trade pricing and fast pallet delivery across the UK.`),
      };
    },
  },
  // /shop/tiles/<slug> (legacy PDP)
  {
    pattern: /^\/shop\/tiles\/([^/?#]+)\/?$/i,
    build: (m) => {
      const name = titleCase(decodeURIComponent(m[1]));
      return {
        title: buildClampedTitle(name, ` · ${BRAND}`),
        description: clampDesc(`Buy ${name} at ${BRAND} — premium UK tile supplier with four showrooms. Free samples, trade pricing and fast pallet delivery across the UK.`),
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
        title: buildClampedTitle(name, ` · ${BRAND}`),
        description: clampDesc(`${name} — ${BRAND} information page. UK tile, bathroom and flooring specialists with four showrooms across Kent, Essex and London.`),
      };
    },
  },
  // /shop/tile-scale-print/<size> → printable scale ruler page, noindex
  {
    pattern: /^\/shop\/tile-scale-print\/[^/?#]+\/?$/i,
    build: () => ({
      title: `Tile Scale Print · ${BRAND}`,
      description: 'Printable to-scale tile rulers for visualising tile sizes in your room before ordering — free templates for every standard tile size sold by Tile Station.',
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
        title: buildClampedTitle(`${name} Collection`, ` · ${BRAND}`),
        description: clampDesc(`Explore the ${name} tile collection at ${BRAND}. Browse the full range, order free samples and arrange UK-wide delivery — across England, Scotland and Wales.`),
        noindex: true,  // sub-paths are not canonical
      };
    },
  },

  // ─────────────────────────────────────────────────────────────────
  // 24 Feb 2026 — catch-all noindex prefixes for admin/customer/staff
  // routes. These pages should never be indexed (auth-gated, personal
  // data, no SEO value). Previously they fell through to FALLBACK and
  // contributed to Ahrefs's "duplicate title" cluster.
  // ─────────────────────────────────────────────────────────────────
  {
    pattern: /^\/admin(?:\/.*)?$/i,
    build: () => ({
      title: `Admin · ${BRAND}`,
      description: `${BRAND} admin console — staff-only area for managing products, orders, customers, content, marketing and SEO. Not for public access.`,
      noindex: true,
    }),
  },
  {
    pattern: /^\/customer\/.+$/i,
    build: () => ({
      title: `Customer Account · ${BRAND}`,
      description: 'Your Tile Station customer account — orders, samples, wishlist and trade-status. Sign in to view your personal dashboard.',
      noindex: true,
    }),
  },
  {
    pattern: /^\/staff-register(?:\/.+)?$/i,
    build: () => ({
      title: `Staff Registration · ${BRAND}`,
      description: 'Staff registration link for new Tile Station employees — please use the invite code provided by your manager to set up your account.',
      noindex: true,
    }),
  },
];

const FALLBACK = {
  title: `${BRAND} — Premium Tiles, Bathrooms and Flooring`,
  description: 'UK tile, bathroom and flooring specialist with four Kent, Essex and London showrooms. 1,000+ porcelain, marble, terrazzo and engineered wood ranges.',
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
    // 5 Jun 2026 — Auto-fixer (db.seo_noindex_flags) can flag pages as
    // noindex when it detects duplicate titles. But certain pages are
    // critical for SEO and must NEVER be auto-noindex'd (the autofixer's
    // duplicate-title heuristic over-fires on category pages that
    // legitimately share a title pattern with the homepage). The list
    // below is the explicit "always-indexable" safe list. The auto-fixer
    // can still flag everything else.
    const ALWAYS_INDEXABLE = new Set([
      '/',
      '/new-collection',
      '/clearance',
      '/shop',
      '/tiles',
      '/contact',
      '/about',
      '/showrooms',
      '/showroom-signup',
      '/blog',
      '/faq',
      '/shop/faq',
    ]);
    if (isNoindexPath(normalised) && !ALWAYS_INDEXABLE.has(normalised)) {
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
