import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { Search, ArrowRight } from 'lucide-react';
import { Card, CardContent } from './ui/card';
import { Input } from './ui/input';
import { useHubCardFilter } from '../hooks/useHubCardFilter';

export default function HubPage({ title, subtitle, cards, sections, icon: Icon, preCardsContent }) {
  const [searchTerm, setSearchTerm] = useState('');
  // 16 May 2026 — hub cards are now gated by the same role+overrides
  // permission system as the sidebar. If a Staff role's `sync_hub` page
  // is removed, the Sync Hub card disappears from the Products Hub too.
  // Cards may opt out by omitting the `permission` field entirely.
  const keepByPermission = useHubCardFilter();

  // Support both flat cards array and grouped sections
  const hasGroupedSections = sections && sections.length > 0;

  // Filter function — combines permission gate AND search.
  const matchesSearch = (card) => {
    const term = searchTerm.toLowerCase();
    return card.title.toLowerCase().includes(term) ||
      card.description.toLowerCase().includes(term) ||
      (card.tabs && card.tabs.some(t => t.toLowerCase().includes(term)));
  };
  const matchesFilter = (card) => keepByPermission(card) && matchesSearch(card);

  // Filter flat cards
  const filteredCards = cards ? cards.filter(matchesFilter) : [];

  // Filter grouped sections
  const filteredSections = hasGroupedSections
    ? sections.map(section => ({
        ...section,
        cards: section.cards.filter(matchesFilter)
      })).filter(section => section.cards.length > 0)
    : [];

  const renderCard = (card) => {
    const cardContent = (
      <Card className={`h-full hover:shadow-lg transition-all cursor-pointer group border-2 hover:border-gray-300 ${card.disabled ? 'opacity-60' : ''}`}>
        <CardContent className="pt-5 pb-4 px-5">
          <div className="flex items-start justify-between mb-3">
            <div className={`w-11 h-11 rounded-lg ${card.color || 'bg-gray-500'} flex items-center justify-center`}>
              <card.icon className="w-5 h-5 text-white" />
            </div>
            <div className="flex items-center gap-2">
              {card.badge && (
                <span
                  className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200"
                  title={card.badgeTitle || card.badge}
                  data-testid={`card-badge-${card.title.toLowerCase().replace(/\s+/g, '-')}`}
                >
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                  {card.badge}
                </span>
              )}
              <ArrowRight className="w-4 h-4 text-gray-300 opacity-0 group-hover:opacity-100 transition-opacity mt-1" />
            </div>
          </div>
          <h3 className="font-semibold text-base mb-1 group-hover:text-blue-600 transition-colors">
            {card.title}
          </h3>
          <p className="text-sm text-gray-500 mb-3 leading-snug">{card.description}</p>
          {card.tabs && card.tabs.length > 0 && (
            <div className="flex flex-wrap gap-1.5" data-testid={`card-tabs-${card.title.toLowerCase().replace(/\s+/g, '-')}`}>
              {card.tabs.map((tab) => (
                <span
                  key={tab}
                  className="inline-block text-xs font-medium px-2 py-0.5 rounded-md bg-gray-100 text-gray-600 border border-gray-200"
                >
                  {tab}
                </span>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    );

    if (card.onClick) {
      return (
        <div key={card.title} onClick={card.disabled ? undefined : card.onClick}>
          {cardContent}
        </div>
      );
    }

    return (
      <Link key={card.link} to={card.link}>
        {cardContent}
      </Link>
    );
  };

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div className="flex items-center gap-3">
          {Icon && <Icon className="w-8 h-8 text-gray-700" />}
          <div>
            <h1 className="text-2xl font-bold text-gray-900">{title}</h1>
            <p className="text-gray-500">{subtitle}</p>
          </div>
        </div>
        
        {/* Search */}
        <div className="relative w-full md:w-80">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <Input
            placeholder="Search sections..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="pl-10"
          />
        </div>
      </div>

      {/* Optional content rendered above the cards/sections (e.g. reconciliation tile) */}
      {preCardsContent && !searchTerm && (
        <div data-testid="hub-pre-cards-content">{preCardsContent}</div>
      )}

      {/* Grouped Sections */}
      {hasGroupedSections && filteredSections.map((section) => (
        <div key={section.title} className="space-y-3">
          <div className="flex items-center gap-2">
            {section.icon && <section.icon className={`w-5 h-5 ${section.iconColor || 'text-gray-600'}`} />}
            <h2 className="text-lg font-semibold text-gray-800">{section.title}</h2>
            <span className="text-xs text-gray-400 bg-gray-100 px-2 py-0.5 rounded-full">
              {section.cards.length}
            </span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {section.cards.map(renderCard)}
          </div>
        </div>
      ))}

      {/* Flat Cards Grid (backward compatibility) */}
      {!hasGroupedSections && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {filteredCards.map(renderCard)}
        </div>
      )}

      {((hasGroupedSections && filteredSections.length === 0) || 
        (!hasGroupedSections && filteredCards.length === 0)) && searchTerm && (
        <div className="text-center py-12">
          <p className="text-gray-500">No sections found matching "{searchTerm}"</p>
        </div>
      )}
    </div>
  );
}
