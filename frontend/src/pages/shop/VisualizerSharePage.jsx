/**
 * Public viewer for a shared visualizer render.
 *
 * Route: /visualizer/share/:token
 *
 * Bypasses the public feature flag so links keep working even if the
 * visualizer is paused. Pulls render + tile metadata via the public
 * `GET /api/visualizer/share/:token` endpoint and shows a clean,
 * shareable card with a "Get this look" CTA that drops the customer
 * onto the live visualizer pre-loaded with the same tile.
 */
import React, { useEffect, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import axios from 'axios';
import { Loader2, Sparkles, ShoppingBag, ArrowRight } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Card } from '../../components/ui/card';
import { ShopHeader, ShopFooter } from './TileStationHome';
import { normaliseImageUrl } from '../../utils/safeStr';

const API = process.env.REACT_APP_BACKEND_URL;

const VisualizerSharePage = () => {
  const { token } = useParams();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!token) return;
    axios.get(`${API}/api/visualizer/share/${token}`)
      .then((r) => setData(r.data))
      .catch((e) => setError(e?.response?.data?.detail || 'This design link has expired or never existed.'));
  }, [token]);

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col" data-testid="visualizer-share-page">
      <ShopHeader />
      <main className="flex-1 max-w-4xl mx-auto px-4 sm:px-6 py-10 w-full">
        {!data && !error && (
          <div className="flex flex-col items-center justify-center py-24 text-slate-500">
            <Loader2 className="w-8 h-8 animate-spin text-yellow-500 mb-3" />
            <div className="text-sm">Loading shared design…</div>
          </div>
        )}

        {error && (
          <Card className="p-10 text-center" data-testid="visualizer-share-error">
            <h1 className="text-2xl font-bold text-slate-900 mb-2">Design link not found</h1>
            <p className="text-slate-600 mb-6">{error}</p>
            <Button
              onClick={() => navigate('/visualizer')}
              className="bg-slate-900 hover:bg-slate-800 text-yellow-300 font-bold"
              data-testid="visualizer-share-error-cta"
            >
              <Sparkles className="w-4 h-4 mr-1" /> Try the Visualizer
            </Button>
          </Card>
        )}

        {data && (
          <>
            <div className="mb-6">
              <div className="text-xs uppercase tracking-wider text-yellow-600 font-bold mb-1">
                Shared design · Tile Station Visualizer
              </div>
              <h1 className="text-3xl sm:text-4xl font-bold text-slate-900 tracking-tight" data-testid="visualizer-share-title">
                {data.tile?.name || 'Tile preview'}
              </h1>
              {data.room_label && (
                <p className="text-slate-600 mt-1">in {data.room_label}</p>
              )}
            </div>

            <Card className="overflow-hidden mb-6">
              <img
                src={data.result_url}
                alt={`Visualizer render of ${data.tile?.name}`}
                className="w-full h-auto block"
                data-testid="visualizer-share-image"
              />
              {data.style === 'photoreal' && (
                <div className="px-4 py-2 bg-emerald-50 border-t border-emerald-200 text-emerald-800 text-xs font-semibold flex items-center gap-1">
                  <Sparkles className="w-3 h-3" /> Photoreal render
                </div>
              )}
            </Card>

            <Card className="p-5 flex items-start justify-between gap-4 flex-wrap" data-testid="visualizer-share-cta-card">
              <div className="flex items-center gap-3">
                {data.tile?.image && (
                  <img src={normaliseImageUrl(data.tile.image)} alt="" className="w-16 h-16 rounded-lg object-cover border border-slate-200" />
                )}
                <div>
                  <div className="font-bold text-slate-900">{data.tile?.name}</div>
                  {data.tile?.price_per_m2 && (
                    <div className="text-sm text-slate-600">
                      £{Number(data.tile.price_per_m2).toFixed(2)} / m²
                    </div>
                  )}
                </div>
              </div>
              <div className="flex gap-2 flex-wrap">
                {data.tile?.id && (
                  <Link to={`/tiles/${data.tile.id}`}>
                    <Button variant="outline" className="border-slate-300" data-testid="visualizer-share-view-tile-btn">
                      <ShoppingBag className="w-4 h-4 mr-1" /> View tile
                    </Button>
                  </Link>
                )}
                <Button
                  onClick={() => navigate(`/visualizer?tile=${encodeURIComponent(data.tile?.id || '')}`)}
                  className="bg-gradient-to-r from-amber-400 to-yellow-500 hover:from-amber-500 hover:to-yellow-600 text-slate-900 font-bold"
                  data-testid="visualizer-share-try-btn"
                >
                  <Sparkles className="w-4 h-4 mr-1" /> Try this tile in your room
                  <ArrowRight className="w-4 h-4 ml-1" />
                </Button>
              </div>
            </Card>

            <div className="mt-6 text-center text-xs text-slate-500">
              Shared from <Link to="/" className="font-semibold text-slate-700 hover:underline">tilestation.co.uk</Link> · AI render — actual tile may vary slightly.
            </div>
          </>
        )}
      </main>
      <ShopFooter />
    </div>
  );
};

export default VisualizerSharePage;
