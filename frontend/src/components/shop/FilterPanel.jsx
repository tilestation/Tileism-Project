import React, { useState, useEffect } from 'react';
import { Filter, X, ChevronDown, ChevronUp, SlidersHorizontal } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Checkbox } from '../../components/ui/checkbox';
import { Label } from '../../components/ui/label';
import { Badge } from '../../components/ui/badge';
import { Slider } from '../../components/ui/slider';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '../../components/ui/sheet';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../../components/ui/collapsible';

const API_URL = process.env.REACT_APP_BACKEND_URL;

const FilterPanel = ({ 
  pageSlug = 'collections', 
  category = null,
  group = null,  // Pass group to filter values to only that group
  onFilterChange,
  className = '',
  style = 'sidebar' // sidebar, drawer, topbar
}) => {
  const [filterData, setFilterData] = useState(null);
  const [selectedFilters, setSelectedFilters] = useState({});
  const [expandedSections, setExpandedSections] = useState({});
  const [loading, setLoading] = useState(true);
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);

  useEffect(() => {
    fetchFilters();
  }, [pageSlug, category, group]);

  const fetchFilters = async () => {
    try {
      const url = new URL(`${API_URL}/api/filters/for-page/${pageSlug}`);
      if (category) url.searchParams.append('category', category);
      if (group) url.searchParams.append('group', group);
      // Use "tiles" collection for live products only (not all supplier_products)
      url.searchParams.append('source', 'tiles');
      
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        setFilterData(data);
        
        // Collapse all sections by default for cleaner UI
        const expanded = {};
        data.filter_groups?.forEach(group => {
          group.filters?.forEach(filter => {
            expanded[filter.id] = false;
          });
        });
        setExpandedSections(expanded);
      }
    } catch (e) {
      console.error('Failed to load filters:', e);
    } finally {
      setLoading(false);
    }
  };

  const handleFilterChange = (filterSlug, value, checked) => {
    setSelectedFilters(prev => {
      const current = prev[filterSlug] || [];
      let updated;
      
      if (checked) {
        updated = [...current, value];
      } else {
        updated = current.filter(v => v !== value);
      }
      
      const newFilters = { ...prev, [filterSlug]: updated };
      
      // Remove empty filter arrays
      if (updated.length === 0) {
        delete newFilters[filterSlug];
      }
      
      // Notify parent
      if (onFilterChange) {
        onFilterChange(newFilters);
      }
      
      return newFilters;
    });
  };

  const handleRangeChange = (filterSlug, values) => {
    setSelectedFilters(prev => {
      const newFilters = { ...prev, [filterSlug]: values };
      if (onFilterChange) {
        onFilterChange(newFilters);
      }
      return newFilters;
    });
  };

  const handleToggleChange = (filterSlug, checked) => {
    setSelectedFilters(prev => {
      const newFilters = { ...prev };
      if (checked) {
        newFilters[filterSlug] = true;
      } else {
        delete newFilters[filterSlug];
      }
      if (onFilterChange) {
        onFilterChange(newFilters);
      }
      return newFilters;
    });
  };

  const clearAllFilters = () => {
    setSelectedFilters({});
    if (onFilterChange) {
      onFilterChange({});
    }
  };

  const toggleSection = (filterId) => {
    setExpandedSections(prev => ({
      ...prev,
      [filterId]: !prev[filterId]
    }));
  };

  const getActiveFilterCount = () => {
    return Object.values(selectedFilters).reduce((count, val) => {
      if (Array.isArray(val)) return count + val.length;
      if (val === true) return count + 1;
      return count;
    }, 0);
  };

  const renderFilterInput = (filter) => {
    const values = filter.values || [];
    
    switch (filter.input_type) {
      case 'checkbox':
        return (
          <div className="space-y-2">
            {values.filter(v => v.is_active !== false).map((option, idx) => {
              const isChecked = (selectedFilters[filter.slug] || []).includes(option.value);
              return (
                <div key={idx} className="flex items-center gap-2">
                  <Checkbox
                    id={`${filter.slug}-${option.value}`}
                    checked={isChecked}
                    onCheckedChange={(checked) => handleFilterChange(filter.slug, option.value, checked)}
                  />
                  <Label 
                    htmlFor={`${filter.slug}-${option.value}`}
                    className="text-sm cursor-pointer flex-1 flex items-center justify-between gap-2"
                  >
                    <span>{option.label || option.value}</span>
                    {typeof option.count === 'number' && (
                      <span className="text-[11px] text-gray-400 tabular-nums" data-testid={`filter-count-${filter.slug}-${option.value}`}>
                        {option.count}
                      </span>
                    )}
                  </Label>
                </div>
              );
            })}
          </div>
        );
      
      case 'range':
        const minVal = parseFloat(values.find(v => v.value === 'min')?.label || 0);
        const maxVal = parseFloat(values.find(v => v.value === 'max')?.label || 100);
        const currentRange = selectedFilters[filter.slug] || [minVal, maxVal];
        
        return (
          <div className="px-2 py-4">
            <Slider
              value={currentRange}
              min={minVal}
              max={maxVal}
              step={1}
              onValueChange={(values) => handleRangeChange(filter.slug, values)}
              className="mb-2"
            />
            <div className="flex justify-between text-xs text-gray-500">
              <span>£{currentRange[0]}/m²</span>
              <span>£{currentRange[1]}/m²</span>
            </div>
          </div>
        );
      
      case 'toggle':
        return (
          <div className="flex items-center gap-2 py-2">
            <Checkbox
              id={`toggle-${filter.slug}`}
              checked={selectedFilters[filter.slug] === true}
              onCheckedChange={(checked) => handleToggleChange(filter.slug, checked)}
            />
            <Label htmlFor={`toggle-${filter.slug}`} className="text-sm cursor-pointer">
              {filter.description || 'Enable'}
            </Label>
          </div>
        );
      
      case 'dropdown':
        return (
          <select 
            className="w-full p-2 border rounded text-sm"
            value={selectedFilters[filter.slug]?.[0] || ''}
            onChange={(e) => {
              if (e.target.value) {
                setSelectedFilters(prev => ({ ...prev, [filter.slug]: [e.target.value] }));
                if (onFilterChange) onFilterChange({ ...selectedFilters, [filter.slug]: [e.target.value] });
              } else {
                const newFilters = { ...selectedFilters };
                delete newFilters[filter.slug];
                setSelectedFilters(newFilters);
                if (onFilterChange) onFilterChange(newFilters);
              }
            }}
          >
            <option value="">All</option>
            {values.filter(v => v.is_active !== false).map((option, idx) => (
              <option key={idx} value={option.value}>{option.label || option.value}</option>
            ))}
          </select>
        );
      
      default:
        return null;
    }
  };

  const FilterContent = () => (
    <div className="space-y-4">
      {/* Header with clear button */}
      <div className="flex items-center justify-between">
        <h3 className="font-semibold flex items-center gap-2">
          <Filter className="w-4 h-4" />
          Filters
        </h3>
        {getActiveFilterCount() > 0 && (
          <Button variant="ghost" size="sm" onClick={clearAllFilters} className="text-xs h-7">
            Clear all
          </Button>
        )}
      </div>

      {/* Active filters */}
      {getActiveFilterCount() > 0 && (
        <div className="flex flex-wrap gap-1 pb-2 border-b">
          {Object.entries(selectedFilters).map(([key, values]) => {
            if (Array.isArray(values)) {
              return values.map(val => (
                <Badge 
                  key={`${key}-${val}`} 
                  variant="secondary" 
                  className="text-xs pl-2 pr-1 py-0.5"
                >
                  {val}
                  <button 
                    onClick={() => handleFilterChange(key, val, false)}
                    className="ml-1 hover:text-red-500"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </Badge>
              ));
            } else if (values === true) {
              return (
                <Badge key={key} variant="secondary" className="text-xs pl-2 pr-1 py-0.5">
                  {key}
                  <button 
                    onClick={() => handleToggleChange(key, false)}
                    className="ml-1 hover:text-red-500"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </Badge>
              );
            }
            return null;
          })}
        </div>
      )}

      {/* Filter sections */}
      {filterData?.filter_groups?.map(group => (
        <div key={group.id}>
          {group.filters?.map(filter => (
            <Collapsible 
              key={filter.id} 
              open={expandedSections[filter.id]} 
              onOpenChange={() => toggleSection(filter.id)}
            >
              <CollapsibleTrigger className="flex items-center justify-between w-full py-2 hover:bg-gray-50 rounded px-1">
                <span className="font-medium text-sm">{filter.name}</span>
                {expandedSections[filter.id] ? (
                  <ChevronUp className="w-4 h-4 text-gray-500" />
                ) : (
                  <ChevronDown className="w-4 h-4 text-gray-500" />
                )}
              </CollapsibleTrigger>
              <CollapsibleContent className="pl-1 pb-3">
                {renderFilterInput(filter)}
              </CollapsibleContent>
            </Collapsible>
          ))}
        </div>
      ))}
    </div>
  );

  if (loading) {
    return (
      <div className={`animate-pulse ${className}`}>
        <div className="h-6 bg-gray-200 rounded w-20 mb-4"></div>
        <div className="space-y-3">
          {[1,2,3].map(i => (
            <div key={i} className="h-4 bg-gray-200 rounded w-full"></div>
          ))}
        </div>
      </div>
    );
  }

  if (!filterData?.filter_groups?.length) {
    return null;
  }

  // Drawer style (mobile-friendly)
  if (style === 'drawer') {
    return (
      <>
        <Sheet open={isDrawerOpen} onOpenChange={setIsDrawerOpen}>
          <SheetTrigger asChild>
            <Button variant="outline" className="flex items-center gap-2">
              <SlidersHorizontal className="w-4 h-4" />
              Filters
              {getActiveFilterCount() > 0 && (
                <Badge variant="default" className="ml-1 h-5 w-5 p-0 flex items-center justify-center text-xs">
                  {getActiveFilterCount()}
                </Badge>
              )}
            </Button>
          </SheetTrigger>
          <SheetContent side="left" className="w-80">
            <SheetHeader>
              <SheetTitle>Filters</SheetTitle>
            </SheetHeader>
            <div className="mt-4 overflow-y-auto max-h-[calc(100vh-100px)]">
              <FilterContent />
            </div>
          </SheetContent>
        </Sheet>
      </>
    );
  }

  // Topbar style
  if (style === 'topbar') {
    return (
      <div className={`flex items-center gap-4 flex-wrap ${className}`}>
        {filterData?.filter_groups?.map(group => (
          group.filters?.slice(0, 4).map(filter => (
            <div key={filter.id} className="relative">
              <select 
                className="appearance-none bg-white border rounded-lg px-3 py-2 pr-8 text-sm cursor-pointer hover:border-gray-400"
                value={selectedFilters[filter.slug]?.[0] || ''}
                onChange={(e) => {
                  if (e.target.value) {
                    handleFilterChange(filter.slug, e.target.value, true);
                  } else {
                    const newFilters = { ...selectedFilters };
                    delete newFilters[filter.slug];
                    setSelectedFilters(newFilters);
                    if (onFilterChange) onFilterChange(newFilters);
                  }
                }}
              >
                <option value="">{filter.name}</option>
                {filter.values?.filter(v => v.is_active !== false).map((opt, i) => (
                  <option key={i} value={opt.value}>{opt.label || opt.value}</option>
                ))}
              </select>
              <ChevronDown className="w-4 h-4 absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none text-gray-500" />
            </div>
          ))
        ))}
        {getActiveFilterCount() > 0 && (
          <Button variant="ghost" size="sm" onClick={clearAllFilters}>
            Clear filters
          </Button>
        )}
      </div>
    );
  }

  // Default sidebar style
  return (
    <div className={`bg-white rounded-lg p-4 border ${className}`}>
      <FilterContent />
    </div>
  );
};

export default FilterPanel;
