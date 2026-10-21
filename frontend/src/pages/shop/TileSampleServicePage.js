import React, { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Package, Truck, CheckCircle, Scissors, ArrowRight, MapPin, Clock, Info } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { ShopHeader, ShopFooter } from './TileStationHome';

const API_URL = process.env.REACT_APP_BACKEND_URL;

// Default content - can be overridden by admin
const defaultContent = {
  global_enabled: true,
  hero_title: "Our Sample Service",
  hero_subtitle: "See and feel your tiles before you buy. Free cut samples on most tiles, with optional Full Size Samples for large-format tiles where pattern, shade and scale really matter.",
  section1_title: "How It Works",
  step1_title: "1. Browse & Select",
  step1_text: "Pick any tile and tap Order Sample. We auto-detect the right option for that tile size — small tiles ship as the actual tile, mid-sized tiles get a free 10×10 cm cut, large tiles also offer a Full Size Sample for £5.",
  step2_title: "2. Checkout",
  step2_text: "Up to 3 free samples per order. Add as many Full Size Samples (£5 each) as you like. Delivery is £2.99 in total — or collect free from any of our showrooms.",
  step3_title: "3. Receive & Compare",
  step3_text: "Samples arrive within 3-5 working days. Hold them in your light, against your décor, and across larger floor areas before you commit.",
  section2_title: "Why Order Samples?",
  benefit1_title: "True Colours",
  benefit1_text: "Screen colours can vary. See the actual tile colour in your space with natural lighting.",
  benefit2_title: "Feel the Texture",
  benefit2_text: "Touch and feel the surface finish - matt, gloss, textured or polished.",
  benefit3_title: "Perfect Match",
  benefit3_text: "Match with your existing décor, furniture and fittings before committing.",
  benefit4_title: "No Risk",
  benefit4_text: "Make confident decisions knowing exactly what you're getting.",
  section3_title: "Sample Details",
  detail1: "Small tiles (≤200×200 mm or 100×300 mm) ship as the actual full tile — no cutting needed",
  detail2: "Mid-size tiles ship as approx. 10×10 cm cut samples — free of charge",
  detail3: "Large-format tiles (≥600×600 mm) also offer a 300×600 mm Full Size Sample for £5",
  detail4: "Maximum 3 FREE samples per order. Full Size Samples are unlimited.",
  detail5: "£2.99 Royal Mail delivery — or collect free from Tonbridge / Gravesend / Sydenham",
  cta_title: "Ready to Start?",
  cta_text: "Browse our collection and start selecting your samples today.",
  cta_button: "Browse Tiles",
  showroom_text: "Prefer to see tiles in person? Visit one of our showrooms in Tonbridge, Gravesend or Sydenham — sample collection is always free."
};

const TileSampleServicePage = () => {
  const navigate = useNavigate();
  const [content, setContent] = useState(defaultContent);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchContent = async () => {
      try {
        const res = await fetch(`${API_URL}/api/content/sample-service`);
        if (res.ok) {
          const data = await res.json();
          if (data && Object.keys(data).length > 0) {
            setContent({ ...defaultContent, ...data });
          }
        }
      } catch (e) {
        console.log('Using default content');
      } finally {
        setLoading(false);
      }
    };
    fetchContent();
  }, []);

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50">
        <ShopHeader />
        <div className="container mx-auto px-4 py-16 text-center">
          <div className="animate-spin w-8 h-8 border-4 border-[#333333] border-t-transparent rounded-full mx-auto"></div>
        </div>
        <ShopFooter />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50" data-testid="sample-service-page">
      <ShopHeader />

      {/* Service-paused banner — shown when admin has toggled the
          sample service OFF site-wide. Customers can still read the
          page so they understand what samples are when we re-enable. */}
      {content.global_enabled === false && (
        <div className="bg-amber-50 border-b border-amber-200 py-4" data-testid="sample-service-paused-banner">
          <div className="container mx-auto px-4 text-center">
            <p className="text-sm text-amber-900">
              <strong>Sample service is currently paused.</strong> Please email{' '}
              <a href="mailto:samples@tilestation.co.uk" className="underline font-semibold">
                samples@tilestation.co.uk
              </a>{' '}
              or visit any showroom for sample availability.
            </p>
          </div>
        </div>
      )}

      {/* Hero Section */}
      <div className="bg-[#333333] text-white py-16">
        <div className="container mx-auto px-4 text-center">
          <div className="inline-flex items-center gap-2 bg-[#F7EA1C] text-[#333333] px-4 py-2 rounded-full mb-6">
            <Scissors className="h-5 w-5" />
            <span className="font-semibold">Free Cut Samples</span>
          </div>
          <h1 className="text-3xl md:text-5xl font-bold mb-4">{content.hero_title}</h1>
          <p className="text-lg md:text-xl text-gray-300 max-w-2xl mx-auto">
            {content.hero_subtitle}
          </p>
          <Button 
            onClick={() => navigate('/tiles')}
            className="mt-8 bg-[#F7EA1C] hover:bg-[#e5d918] text-[#333333] font-semibold px-8 py-6"
            data-testid="start-browsing-btn"
          >
            Start Browsing
            <ArrowRight className="ml-2 h-5 w-5" />
          </Button>
        </div>
      </div>

      {/* How It Works Section */}
      <div className="py-16 bg-white">
        <div className="container mx-auto px-4">
          <h2 className="text-2xl md:text-3xl font-bold text-center mb-12">{content.section1_title}</h2>
          
          <div className="grid md:grid-cols-3 gap-8 max-w-5xl mx-auto">
            {/* Step 1 */}
            <div className="text-center">
              <div className="w-16 h-16 bg-[#333333] rounded-full flex items-center justify-center mx-auto mb-4">
                <Scissors className="h-8 w-8 text-[#F7EA1C]" />
              </div>
              <h3 className="text-xl font-semibold mb-3">{content.step1_title}</h3>
              <p className="text-gray-600">{content.step1_text}</p>
            </div>

            {/* Step 2 */}
            <div className="text-center">
              <div className="w-16 h-16 bg-[#333333] rounded-full flex items-center justify-center mx-auto mb-4">
                <Package className="h-8 w-8 text-[#F7EA1C]" />
              </div>
              <h3 className="text-xl font-semibold mb-3">{content.step2_title}</h3>
              <p className="text-gray-600">{content.step2_text}</p>
            </div>

            {/* Step 3 */}
            <div className="text-center">
              <div className="w-16 h-16 bg-[#333333] rounded-full flex items-center justify-center mx-auto mb-4">
                <Truck className="h-8 w-8 text-[#F7EA1C]" />
              </div>
              <h3 className="text-xl font-semibold mb-3">{content.step3_title}</h3>
              <p className="text-gray-600">{content.step3_text}</p>
            </div>
          </div>
        </div>
      </div>

      {/* Three Sample Tiers — explains exactly what each option means */}
      <div className="py-16 bg-white" data-testid="three-tiers-section">
        <div className="container mx-auto px-4">
          <div className="max-w-5xl mx-auto">
            <h2 className="text-2xl md:text-3xl font-bold text-center mb-3">
              Three Sample Options
            </h2>
            <p className="text-center text-gray-600 mb-12 max-w-2xl mx-auto">
              We automatically pick the right option for each tile. Larger tiles
              also have a "Full Size Sample" choice for the most accurate preview.
            </p>

            <div className="grid md:grid-cols-3 gap-6">
              {/* Tier 1 — small tile / actual tile */}
              <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-6">
                <div className="text-xs font-bold text-emerald-700 uppercase tracking-wide mb-2">
                  Tier 1
                </div>
                <h3 className="text-xl font-semibold mb-3">Free Sample — Actual Tile</h3>
                <p className="text-gray-700 text-sm mb-4">
                  For small tiles where the tile itself is small enough to send.
                  This applies to mosaics, small metros and any tile up to roughly
                  200×200 mm or 100×300 mm. <strong>You receive the actual full
                  tile</strong>, not a cut piece.
                </p>
                <div className="border-t border-emerald-200 pt-3 mt-3 text-sm">
                  <div className="font-bold text-emerald-700">FREE</div>
                  <div className="text-gray-600">+ £2.99 delivery (or free showroom collection)</div>
                </div>
              </div>

              {/* Tier 2 — standard cut sample */}
              <div className="bg-amber-50 border border-amber-200 rounded-lg p-6">
                <div className="text-xs font-bold text-amber-700 uppercase tracking-wide mb-2">
                  Tier 2
                </div>
                <h3 className="text-xl font-semibold mb-3">Free Sample — 10×10 cm Cut</h3>
                <p className="text-gray-700 text-sm mb-4">
                  Our standard free sample. We cut a piece of approximately
                  10×10 cm from a full tile so you can see the colour, finish,
                  texture and shade variation in your own light.
                </p>
                <div className="border-t border-amber-200 pt-3 mt-3 text-sm">
                  <div className="font-bold text-amber-700">FREE</div>
                  <div className="text-gray-600">+ £2.99 delivery (or free showroom collection)</div>
                </div>
              </div>

              {/* Tier 3 — full-size paid */}
              <div className="bg-rose-50 border-2 border-rose-300 rounded-lg p-6 relative">
                <div className="absolute -top-3 right-4 bg-rose-500 text-white text-xs font-bold px-3 py-1 rounded-full">
                  RECOMMENDED for large tiles
                </div>
                <div className="text-xs font-bold text-rose-700 uppercase tracking-wide mb-2">
                  Tier 3
                </div>
                <h3 className="text-xl font-semibold mb-3">Full Size Sample — 300×600 mm</h3>
                <p className="text-gray-700 text-sm mb-4">
                  Available on tiles 600×600 mm and larger. We cut a much larger
                  300×600 mm piece so you can <strong>see how the pattern, shade
                  variation and scale work in a real space</strong>. We don't ship
                  the actual full tile size (e.g. 600×1200 mm) — we cut it down
                  to 300×600 mm and call this our <strong>"Full Size Sample"</strong>.
                </p>
                <div className="border-t border-rose-300 pt-3 mt-3 text-sm">
                  <div className="font-bold text-rose-700">£5.00 each</div>
                  <div className="text-gray-600">+ £2.99 delivery (or free showroom collection)</div>
                </div>
              </div>
            </div>

            {/* Why bigger samples are better */}
            <div className="mt-12 bg-gray-50 rounded-lg p-8 max-w-3xl mx-auto">
              <h3 className="text-xl font-semibold mb-4 text-center">
                Why a bigger sample matters for large-format tiles
              </h3>
              <ul className="space-y-3 text-sm text-gray-700">
                <li className="flex gap-3">
                  <span className="text-amber-500 font-bold">•</span>
                  <span>
                    <strong>Pattern repeat is visible.</strong> Many porcelain tiles
                    use a pattern that only repeats every 6–8 tiles. A 10 cm cut
                    can't show that — a 300×600 cut can.
                  </span>
                </li>
                <li className="flex gap-3">
                  <span className="text-amber-500 font-bold">•</span>
                  <span>
                    <strong>Shade variation (V1–V4 rating).</strong> High-variation
                    tiles look very different from one piece to the next. A bigger
                    sample shows the realistic range you'll see installed.
                  </span>
                </li>
                <li className="flex gap-3">
                  <span className="text-amber-500 font-bold">•</span>
                  <span>
                    <strong>Lighting & gloss behaviour.</strong> Polished and matt
                    finishes catch light very differently across a 60 cm span versus
                    a 10 cm cut — you'll see the real visual effect.
                  </span>
                </li>
                <li className="flex gap-3">
                  <span className="text-amber-500 font-bold">•</span>
                  <span>
                    <strong>Confident decision-making.</strong> For a 30+ m² floor,
                    £5 to truly see what you're getting is the cheapest insurance
                    in the project.
                  </span>
                </li>
              </ul>
            </div>
          </div>
        </div>
      </div>

      {/* Why Order Samples Section */}
      <div className="py-16 bg-gray-50">
        <div className="container mx-auto px-4">
          <h2 className="text-2xl md:text-3xl font-bold text-center mb-12">{content.section2_title}</h2>
          
          <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-6 max-w-6xl mx-auto">
            <div className="bg-white p-6 rounded-lg shadow-sm">
              <div className="w-12 h-12 bg-[#F7EA1C] rounded-lg flex items-center justify-center mb-4">
                <CheckCircle className="h-6 w-6 text-[#333333]" />
              </div>
              <h3 className="font-semibold mb-2">{content.benefit1_title}</h3>
              <p className="text-sm text-gray-600">{content.benefit1_text}</p>
            </div>

            <div className="bg-white p-6 rounded-lg shadow-sm">
              <div className="w-12 h-12 bg-[#F7EA1C] rounded-lg flex items-center justify-center mb-4">
                <CheckCircle className="h-6 w-6 text-[#333333]" />
              </div>
              <h3 className="font-semibold mb-2">{content.benefit2_title}</h3>
              <p className="text-sm text-gray-600">{content.benefit2_text}</p>
            </div>

            <div className="bg-white p-6 rounded-lg shadow-sm">
              <div className="w-12 h-12 bg-[#F7EA1C] rounded-lg flex items-center justify-center mb-4">
                <CheckCircle className="h-6 w-6 text-[#333333]" />
              </div>
              <h3 className="font-semibold mb-2">{content.benefit3_title}</h3>
              <p className="text-sm text-gray-600">{content.benefit3_text}</p>
            </div>

            <div className="bg-white p-6 rounded-lg shadow-sm">
              <div className="w-12 h-12 bg-[#F7EA1C] rounded-lg flex items-center justify-center mb-4">
                <CheckCircle className="h-6 w-6 text-[#333333]" />
              </div>
              <h3 className="font-semibold mb-2">{content.benefit4_title}</h3>
              <p className="text-sm text-gray-600">{content.benefit4_text}</p>
            </div>
          </div>
        </div>
      </div>

      {/* Sample Details Section */}
      <div className="py-16 bg-white">
        <div className="container mx-auto px-4">
          <div className="max-w-3xl mx-auto">
            <h2 className="text-2xl md:text-3xl font-bold text-center mb-8">{content.section3_title}</h2>
            
            <div className="bg-[#333333] text-white rounded-lg p-8">
              <ul className="space-y-4">
                <li className="flex items-start gap-3">
                  <Info className="h-5 w-5 text-[#F7EA1C] flex-shrink-0 mt-0.5" />
                  <span>{content.detail1}</span>
                </li>
                <li className="flex items-start gap-3">
                  <CheckCircle className="h-5 w-5 text-[#F7EA1C] flex-shrink-0 mt-0.5" />
                  <span>{content.detail2}</span>
                </li>
                <li className="flex items-start gap-3">
                  <Package className="h-5 w-5 text-[#F7EA1C] flex-shrink-0 mt-0.5" />
                  <span>{content.detail3}</span>
                </li>
                <li className="flex items-start gap-3">
                  <Truck className="h-5 w-5 text-[#F7EA1C] flex-shrink-0 mt-0.5" />
                  <span>{content.detail4}</span>
                </li>
                <li className="flex items-start gap-3">
                  <Clock className="h-5 w-5 text-[#F7EA1C] flex-shrink-0 mt-0.5" />
                  <span>{content.detail5}</span>
                </li>
              </ul>
            </div>
          </div>
        </div>
      </div>

      {/* CTA Section */}
      <div className="py-16 bg-[#F7EA1C]">
        <div className="container mx-auto px-4 text-center">
          <h2 className="text-2xl md:text-3xl font-bold text-[#333333] mb-4">{content.cta_title}</h2>
          <p className="text-[#333333] mb-8 max-w-xl mx-auto">{content.cta_text}</p>
          <Button 
            onClick={() => navigate('/tiles')}
            className="bg-[#333333] hover:bg-[#444444] text-[#F7EA1C] font-semibold px-8 py-6"
            data-testid="browse-tiles-cta-btn"
          >
            {content.cta_button}
            <ArrowRight className="ml-2 h-5 w-5" />
          </Button>
        </div>
      </div>

      {/* Showroom Alternative */}
      <div className="py-12 bg-white">
        <div className="container mx-auto px-4">
          <div className="max-w-3xl mx-auto text-center">
            <div className="flex items-center justify-center gap-2 mb-4">
              <MapPin className="h-6 w-6 text-[#333333]" />
              <h3 className="text-xl font-semibold">Visit Our Showrooms</h3>
            </div>
            <p className="text-gray-600 mb-6">{content.showroom_text}</p>
            <Link 
              to="/shop/contact" 
              className="text-[#333333] hover:text-[#F7EA1C] font-medium underline"
            >
              Find Your Nearest Showroom →
            </Link>
          </div>
        </div>
      </div>

      <ShopFooter />
    </div>
  );
};

export default TileSampleServicePage;
