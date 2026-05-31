import React, { useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '../ui/command';
import { LayoutDashboard } from 'lucide-react';

/**
 * CommandPalette — ⌘K / Ctrl+K jump-to-page search for the admin app.
 *
 * Receives the SAME `filteredGroups` array Layout.js renders in the
 * sidebar, so the palette automatically respects permissions: showroom
 * staff see only the pages they can reach; super-admin sees everything.
 *
 * Each entry's icon comes from the group's nav-item definition, so the
 * visual identity stays consistent with the sidebar.
 */
const CommandPalette = ({ open, onOpenChange, groups, hubLinks }) => {
  const navigate = useNavigate();

  // Flatten groups into searchable entries while preserving group label
  // for the heading. Skip the unlabeled "main" group (Dashboard) — we
  // surface it as its own pinned section at the top instead.
  const sections = useMemo(() => {
    const out = [];
    for (const g of groups || []) {
      if (!g.items || g.items.length === 0) continue;
      out.push({
        id: g.id,
        label: g.label || 'Dashboard',
        items: g.items.map((it) => ({
          to: it.to,
          label: it.label,
          icon: it.icon,
          group: g.label || 'Dashboard',
        })),
      });
    }
    return out;
  }, [groups]);

  // Quick hub-page jumps — surfaced as a separate top section so
  // typing "hub" or "marketing" lands you on the dashboard view of a
  // whole department in one keystroke.
  const hubEntries = useMemo(() => {
    if (!hubLinks) return [];
    return hubLinks.map((h) => ({
      to: h.hubLink,
      label: `${h.label} · Hub`,
      icon: h.icon,
    }));
  }, [hubLinks]);

  const handleSelect = (to) => {
    onOpenChange(false);
    navigate(to);
  };

  // Reset search when palette closes (cmdk keeps state otherwise).
  useEffect(() => {
    if (!open) return;
    // Small focus delay lets the dialog mount before cmdk takes over.
    const t = setTimeout(() => {
      const input = document.querySelector(
        '[data-testid="command-palette-input"]'
      );
      if (input) input.focus();
    }, 30);
    return () => clearTimeout(t);
  }, [open]);

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandInput
        placeholder="Jump to any page… (try 'radio', 'epos', 'invoice')"
        data-testid="command-palette-input"
      />
      <CommandList data-testid="command-palette-list">
        <CommandEmpty>No matching pages.</CommandEmpty>

        {hubEntries.length > 0 && (
          <>
            <CommandGroup heading="Hubs">
              {hubEntries.map((entry) => {
                const Icon = entry.icon || LayoutDashboard;
                return (
                  <CommandItem
                    key={`hub-${entry.to}`}
                    value={`hub ${entry.label}`}
                    onSelect={() => handleSelect(entry.to)}
                    data-testid={`command-palette-hub-${entry.to.replace(
                      /[^a-z0-9]+/gi,
                      '-'
                    )}`}
                  >
                    <Icon className="mr-2 h-4 w-4" />
                    <span>{entry.label}</span>
                  </CommandItem>
                );
              })}
            </CommandGroup>
            <CommandSeparator />
          </>
        )}

        {sections.map((section) => (
          <CommandGroup key={section.id} heading={section.label}>
            {section.items.map((entry) => {
              const Icon = entry.icon || LayoutDashboard;
              return (
                <CommandItem
                  key={entry.to}
                  value={`${entry.group} ${entry.label}`}
                  onSelect={() => handleSelect(entry.to)}
                  data-testid={`command-palette-item-${entry.to.replace(
                    /[^a-z0-9]+/gi,
                    '-'
                  )}`}
                >
                  <Icon className="mr-2 h-4 w-4" />
                  <span>{entry.label}</span>
                  <span className="ml-auto text-[10px] text-muted-foreground uppercase tracking-wider">
                    {entry.group}
                  </span>
                </CommandItem>
              );
            })}
          </CommandGroup>
        ))}
      </CommandList>
    </CommandDialog>
  );
};

export default CommandPalette;
