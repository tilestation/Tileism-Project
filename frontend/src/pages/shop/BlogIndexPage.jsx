/**
 * BlogIndexPage — /blog
 *
 * Lists all published articles produced by the Editorial Autopilot
 * (and any human-authored ones). Used by both visitors and Google
 * (sitemap entry + JSON-LD ItemList).
 */
import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Loader2, BookOpen } from 'lucide-react';
import { ShopHeader, ShopFooter } from './TileStationHome';
import SeoHead from '../../components/seo/SeoHead';

const API_URL = process.env.REACT_APP_BACKEND_URL;


const BlogIndexPage = () => {
  const [articles, setArticles] = useState(null);

  useEffect(() => {
    let alive = true;
    fetch(`${API_URL}/api/shop/blog`)
      .then((r) => r.json())
      .then((d) => { if (alive) setArticles(d.articles || []); })
      .catch(() => { if (alive) setArticles([]); });
    return () => { alive = false; };
  }, []);

  return (
    <div className="min-h-screen bg-stone-50" data-testid="blog-index-page">
      <SeoHead
        title="Tile, Bathroom & Flooring Inspiration · Guides, Trends, How-To · TileStation"
        description="Expert UK guides on tiles, marble, porcelain, grout, bathroom & kitchen design. New articles every week from the TileStation editorial team."
        canonical="/blog"
      />
      <ShopHeader />
      <main className="max-w-5xl mx-auto px-4 py-10 md:py-16">
        <div className="mb-8 md:mb-12">
          <div className="inline-flex items-center gap-2 text-xs uppercase tracking-widest text-amber-700 font-bold mb-3">
            <BookOpen className="w-4 h-4" /> Editorial
          </div>
          <h1 className="text-4xl md:text-5xl font-bold text-stone-900">
            Tile &amp; Stone Inspiration
          </h1>
          <p className="text-stone-600 mt-3 max-w-2xl">
            Practical UK guides, design trends and renovation know-how from the
            TileStation team. New posts every week.
          </p>
        </div>

        {articles === null && (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="w-6 h-6 animate-spin text-stone-400" />
          </div>
        )}

        {articles && articles.length === 0 && (
          <div
            className="border-2 border-dashed border-stone-200 rounded-lg p-12 text-center text-stone-500"
            data-testid="blog-empty-state"
          >
            <BookOpen className="w-10 h-10 mx-auto text-stone-300 mb-3" />
            <p className="font-semibold">Articles coming soon</p>
            <p className="text-xs mt-1">Our editorial autopilot publishes new guides every Monday.</p>
          </div>
        )}

        {articles && articles.length > 0 && (
          <div
            className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5"
            data-testid="blog-grid"
          >
            {articles.map((a) => (
              <Link
                key={a.slug}
                to={`/blog/${a.slug}`}
                className="group block bg-white rounded-lg overflow-hidden border border-stone-200 hover:border-amber-400 hover:shadow-lg transition"
                data-testid={`blog-card-${a.slug}`}
              >
                <div className="aspect-[16/10] bg-stone-100 overflow-hidden">
                  {a.hero_image_url ? (
                    <img
                      src={`${API_URL}${a.hero_image_url}`}
                      alt={a.title}
                      className="w-full h-full object-cover group-hover:scale-[1.02] transition"
                      loading="lazy"
                    />
                  ) : (
                    <div className="w-full h-full bg-gradient-to-br from-amber-100 to-stone-200" />
                  )}
                </div>
                <div className="p-4">
                  <h2 className="text-base font-bold text-stone-900 leading-snug line-clamp-2 group-hover:text-amber-700">
                    {a.title}
                  </h2>
                  {a.meta_description && (
                    <p className="text-xs text-stone-600 mt-2 line-clamp-3">
                      {a.meta_description}
                    </p>
                  )}
                  {a.published_at && (
                    <div className="text-[11px] text-stone-400 mt-3 font-mono">
                      {new Date(a.published_at).toLocaleDateString('en-GB', {
                        day: 'numeric', month: 'short', year: 'numeric',
                      })}
                    </div>
                  )}
                </div>
              </Link>
            ))}
          </div>
        )}
      </main>
      <ShopFooter />
    </div>
  );
};

export default BlogIndexPage;
