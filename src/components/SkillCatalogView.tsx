import React, { useMemo, useState } from 'react';
import {
  CheckCircle2,
  Compass,
  Cpu,
  Layers,
  Search,
  Server,
  Shield,
  Terminal,
  X,
} from 'lucide-react';
import { filterSkills, SKILL_CATALOG } from '../utils/graphData';
import { IconButton } from './IconButton';

const CATEGORY_FILTERS = [
  { id: 'All', label: 'All Skill Categories', icon: Layers },
  { id: 'Coordination', label: 'Coordination Skills', icon: Compass },
  { id: 'Planning', label: 'Planning Skills', icon: Cpu },
  { id: 'Verification', label: 'Verification Skills', icon: CheckCircle2 },
  { id: 'Security', label: 'Security Skills', icon: Shield },
  { id: 'Infrastructure', label: 'Infrastructure Skills', icon: Server },
] as const;

export function SkillCatalogView() {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<string>('All');

  const filtered = useMemo(
    () => filterSkills(SKILL_CATALOG, query, category),
    [query, category]
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-[#382821] pb-5">
        <div>
          <h2 className="font-display text-2xl font-bold tracking-tight text-[#F7F3EC]">
            Canonical Skill Catalog
          </h2>
          <p className="text-sm text-[#B9AA9D] mt-1">
            Versioned skill snapshot backed by the Supabase skills registry and bound tool contracts.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {/* Search Field */}
          <div className="relative">
            <Search className="w-4 h-4 text-[#8C7263] absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search skills or tools..."
              aria-label="Search skills or tools"
              className="w-64 bg-[#1D1411] border border-[#4A362D] text-sm text-[#F2EBE1] placeholder-[#7C695D] pl-9 pr-8 py-2 rounded-sm focus:outline-none focus:border-[#C83214]"
            />
            {query && (
              <div className="absolute right-1 top-1/2 -translate-y-1/2">
                <IconButton
                  label="Clear Search"
                  className="!w-7 !h-7 !border-transparent !bg-transparent hover:!bg-[#2C1F1A]"
                  onClick={() => setQuery('')}
                >
                  <X className="w-3.5 h-3.5" />
                </IconButton>
              </div>
            )}
          </div>

          {/* Icon-Only Category Filter Buttons */}
          <div className="flex items-center gap-1.5 bg-[#1A110E] border border-[#3F2E27] p-1 rounded-sm">
            {CATEGORY_FILTERS.map((cat) => {
              const Icon = cat.icon;
              return (
                <IconButton
                  key={cat.id}
                  label={cat.label}
                  active={category === cat.id}
                  variant="accent"
                  onClick={() => setCategory(cat.id)}
                >
                  <Icon className="w-4 h-4" />
                </IconButton>
              );
            })}
          </div>
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="border border-[#3B2A23] bg-[#1B120F] p-12 text-center space-y-3 rounded-sm">
          <p className="text-sm text-[#CBBFB2]">
            No skills matched your current filter or search query.
          </p>
          <div className="flex justify-center">
            <IconButton
              label="Reset Skill Filters"
              variant="ivory"
              onClick={() => {
                setQuery('');
                setCategory('All');
              }}
            >
              <X className="w-4 h-4" />
            </IconButton>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
          {filtered.map((skill) => (
            <article
              key={skill.id}
              className="bg-[#211613] border border-[#433129] hover:border-[#C83214] transition-colors p-5 rounded-sm flex flex-col justify-between gap-4"
            >
              <div className="space-y-2">
                <div className="flex items-center justify-between text-[11px] font-mono text-[#A89688]">
                  <span>
                    {skill.category} · v{skill.version}
                  </span>
                  <span className="text-[#6CC48E] uppercase">{skill.status}</span>
                </div>

                <h3 className="font-display text-lg font-semibold text-[#F7F3EC]">
                  {skill.name}
                </h3>

                <div className="font-mono text-xs text-[#DF6B3B]">{skill.path}</div>
              </div>

              <div className="pt-3 border-t border-[#382821] space-y-2">
                <div className="text-[10px] font-mono uppercase tracking-wider text-[#9C8A7C]">
                  Bound Tools
                </div>
                <div className="flex flex-wrap gap-1.5 font-mono text-[11px]">
                  {skill.tools.map((tool) => (
                    <span
                      key={tool.slug}
                      className="bg-[#160F0D] border border-[#3F2E27] text-[#DFE4D8] px-2 py-0.5 rounded-xs"
                    >
                      {tool.slug} ({tool.type})
                    </span>
                  ))}
                </div>
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
