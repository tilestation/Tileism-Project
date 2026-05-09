import React, { useState, useEffect } from 'react';
import { Play, X, Film } from 'lucide-react';
import { normaliseImageUrl } from '../../utils/safeStr';

const API_URL = process.env.REACT_APP_BACKEND_URL;

export const ShowroomTours = () => {
  const [config, setConfig] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    const fetchConfig = async () => {
      try {
        const res = await fetch(`${API_URL}/api/website-admin/homepage`);
        const data = await res.json();
        if (data && data.showroom_tours_visible && data.showroom_tours_videos?.length > 0) {
          const enabledVideos = data.showroom_tours_videos.filter(v => v.enabled);
          if (enabledVideos.length > 0) {
            setConfig({
              title: data.showroom_tours_title || 'Explore Our Showrooms',
              subtitle: data.showroom_tours_subtitle || 'Take a virtual tour of each location',
              videos: enabledVideos,
            });
          }
        }
      } catch (e) {
        console.error('Failed to load showroom tours', e);
      } finally {
        setLoaded(true);
      }
    };
    fetchConfig();
  }, []);

  if (!loaded || !config) return null;

  const activeVideo = config.videos[activeIdx] || config.videos[0];

  return (
    <section className="py-16 md:py-24 bg-slate-900 relative overflow-hidden" data-testid="showroom-tours">
      {/* Subtle background pattern */}
      <div className="absolute inset-0 opacity-[0.03]">
        <div className="absolute inset-0" style={{
          backgroundImage: 'radial-gradient(circle at 1px 1px, white 1px, transparent 0)',
          backgroundSize: '40px 40px',
        }} />
      </div>

      <div className="container mx-auto px-4 sm:px-6 lg:px-8 relative z-10">
        {/* Section header */}
        <div className="text-center mb-10">
          <span className="inline-block bg-[#F7EA1C] text-[#333333] text-xs font-bold px-3 py-1 rounded-full mb-4 uppercase tracking-wider">
            Virtual Tours
          </span>
          <h2 className="text-2xl sm:text-3xl md:text-4xl lg:text-5xl font-black text-white tracking-tight">
            {config.title}
          </h2>
          <p className="text-slate-400 text-base sm:text-lg mt-3 max-w-2xl mx-auto">
            {config.subtitle}
          </p>
        </div>

        {/* Main video area */}
        <div className="max-w-4xl mx-auto">
          <div className="aspect-video rounded-2xl overflow-hidden bg-slate-800 relative shadow-2xl mb-6">
            {activeVideo.thumbnail_url ? (
              <img
                src={activeVideo.thumbnail_url}
                alt={activeVideo.title}
                className="w-full h-full object-cover"
              />
            ) : (
              <div className="w-full h-full flex items-center justify-center bg-slate-800">
                <Film className="w-16 h-16 text-slate-600" />
              </div>
            )}
            <div className="absolute inset-0 bg-slate-900/30" />

            {/* Play button overlay */}
            <button
              onClick={() => setPlaying(true)}
              className="absolute inset-0 flex items-center justify-center group"
              data-testid="tours-play-btn"
            >
              <div className="w-20 h-20 bg-white rounded-full flex items-center justify-center shadow-lg group-hover:scale-110 transition-transform">
                <Play className="w-8 h-8 text-slate-900 ml-1" />
              </div>
            </button>

            {/* Title overlay at bottom */}
            <div className="absolute bottom-0 left-0 right-0 p-6 bg-gradient-to-t from-slate-900/90 to-transparent">
              <h3 className="text-xl font-bold text-white">{activeVideo.title}</h3>
              {activeVideo.description && (
                <p className="text-slate-300 text-sm mt-1">{activeVideo.description}</p>
              )}
            </div>
          </div>

          {/* Thumbnail tabs */}
          {config.videos.length > 1 && (
            <div className="flex justify-center gap-4 flex-wrap">
              {config.videos.map((video, idx) => (
                <button
                  key={video.id || idx}
                  onClick={() => { setActiveIdx(idx); setPlaying(false); }}
                  className={`group flex-shrink-0 rounded-xl overflow-hidden border-2 transition-all duration-200 ${
                    idx === activeIdx
                      ? 'border-[#F7EA1C] shadow-lg shadow-yellow-500/20 scale-105'
                      : 'border-slate-700 opacity-60 hover:opacity-100 hover:border-slate-500'
                  }`}
                  data-testid={`tours-tab-${idx}`}
                >
                  <div className="w-32 sm:w-40">
                    <div className="aspect-video bg-slate-700 relative overflow-hidden">
                      {video.thumbnail_url ? (
                        <img src={normaliseImageUrl(video.thumbnail_url)} alt={video.title} className="w-full h-full object-cover" />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center">
                          <Film className="w-6 h-6 text-slate-500" />
                        </div>
                      )}
                      {idx === activeIdx && (
                        <div className="absolute bottom-1 left-1 w-2 h-2 rounded-full bg-[#F7EA1C]" />
                      )}
                    </div>
                    <div className="px-2 py-2 bg-slate-800">
                      <p className="text-xs text-white font-medium truncate">{video.title || 'Tour'}</p>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Video Playback Modal */}
      {playing && activeVideo.video_url && (
        <div className="fixed inset-0 z-50 bg-slate-900/95 flex items-center justify-center p-4">
          <button
            onClick={() => setPlaying(false)}
            className="absolute top-6 right-6 w-12 h-12 bg-white/10 hover:bg-white/20 rounded-full flex items-center justify-center text-white transition-colors"
            data-testid="tours-modal-close"
          >
            <X className="w-6 h-6" />
          </button>
          <div className="w-full max-w-5xl aspect-video bg-slate-800 rounded-xl overflow-hidden">
            <video
              src={activeVideo.video_url}
              className="w-full h-full"
              controls
              autoPlay
            />
          </div>
        </div>
      )}

      {playing && !activeVideo.video_url && (
        <div className="fixed inset-0 z-50 bg-slate-900/95 flex items-center justify-center p-4">
          <button
            onClick={() => setPlaying(false)}
            className="absolute top-6 right-6 w-12 h-12 bg-white/10 hover:bg-white/20 rounded-full flex items-center justify-center text-white transition-colors"
          >
            <X className="w-6 h-6" />
          </button>
          <div className="text-center text-white">
            <Play className="w-16 h-16 mx-auto mb-4 opacity-50" />
            <p className="text-xl font-bold">Video Coming Soon</p>
            <p className="text-slate-400 mt-2">This showroom tour is being prepared.</p>
          </div>
        </div>
      )}
    </section>
  );
};

export default ShowroomTours;
