import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Layers, Loader2, Search, X } from 'lucide-react';
import type { SkillRecord, SkillsSubstrateResponse } from '../types/substrate';
import { filterSkills } from '../utils/graphData';
import { IconButton } from './IconButton';

interface SkillCatalogViewProps {
  refreshTick?: number;
  onLoadingChange?: (loading: boolean) => void;
}

export function SkillCatalogView({ refreshTick = 0, onLoadingChange }: SkillCatalogViewProps) {
  const [skills, setSkills] = useState<SkillRecord[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<string>('All');

  const fetchSkills = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    onLoadingChange?.(true);
    setError(null);
    try {
      const res = await fetch('/api/substrate/skills', { signal });
      const payload = (await res.json()) as Partial<SkillsSubstrateResponse> & { error?: string };
      if (!res.ok) {
        throw new Error(payload.error || `Failed to load skills (HTTP ${res.status})`);
      }
      const nextSkills = Array.isArray(payload.skills) ? payload.skills : [];
      const nextCats = Array.isArray(payload.categories)
        ? payload.categories
        : Array.from(new Set(nextSkills.map((s) => s.category))).sort();
      setSkills(nextSkills);
      setCategories(nextCats);
    } catch (err) {
      if ((err as { name?: string })?.name === 'AbortError') return;
      setError(err instanceof Error ? err.message : 'Unable to load skills catalog from Supabase.');
    } finally {
      if (!signal?.aborted) {
        setLoading(false);
        onLoadingChange?.(false);
      }
    }
  }, [onLoadingChange]);

  useEffect(() => {
    const controller = new AbortController();
    void fetchSkills(controller.signal);
    return () => controller.abort();
  }, [fetchSkills, refreshTick]);

  const categoryOptions = useMemo(() => {
    return Array.from(new Set(categories.filter(Boolean))).sort();
  }, [categories]);

  const filtered = useMemo(
    () => filterSkills(skills, query, category),
    [skills, query, category]
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-[#382821] pb-5">
        <div>
          <h2 className="font-display text-2xl font-bold tracking-tight text-[#F7F3EC]">
            Canonical Skill Catalog
          </h2>
          <p className="text-sm text-[#B9AA9D] mt-1">
            Live skills registry and bound tool contracts from the connected Supabase database ({skills.length} total).
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
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

          <div className="relative flex items-center">
            <Layers className="w-4 h-4 text-[#DF6B3B] absolute left-3 pointer-events-none" />
            <select
              aria-label="Filter by skill category"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="bg-[#1D1411] border border-[#4A362D] text-sm text-[#F2EBE1] pl-9 pr-8 py-2 rounded-sm focus:outline-none focus:border-[#C83214] cursor-pointer"
            >
              <option value="All">All Categories ({skills.length})</option>
              {categoryOptions.map((cat) => {
                const count = skills.filter((s) => s.category === cat).length;
                return (
                  <option key={cat} value={cat}>
                    {cat} ({count})
                  </option>
                );
              })}
            </select>
          </div>
        </div>
      </div>

      {error && (
        <div
          role="alert"
          className="border border-[#C83214] bg-[#241310] px-4 py-3 rounded-sm flex items-center justify-between gap-3 text-xs text-[#F7F3EC]"
        >
          <div className="flex items-start gap-2.5 min-w-0">
            <AlertTriangle className="w-4 h-4 text-[#E04819] shrink-0 mt-0.5" />
            <span className="font-mono break-words">{error}</span>
          </div>
          <button
            type="button"
            onClick={() => void fetchSkills()}
            className="px-2.5 py-1 text-[11px] font-mono bg-[#C83214] hover:bg-[#E04819] text-[#F7F3EC] rounded-xs shrink-0 cursor-pointer"
          >
            Retry
          </button>
        </div>
      )}

      {loading && skills.length === 0 ? (
        <div className="border border-[#3B2A23] bg-[#1B120F] p-12 flex items-center justify-center gap-3 text-xs font-mono text-[#DFE4D8] rounded-sm">
          <Loader2 className="w-4 h-4 animate-spin text-[#E04819]" />
          <span>Loading skills catalog from Supabase ledger...</span>
        </div>
      ) : skills.length === 0 && !error ? (
        <div className="border border-[#3B2A23] bg-[#1B120F] p-12 text-center space-y-2 rounded-sm">
          <div className="font-display text-base font-semibold text-[#F7F3EC]">
            No Skills Registered
          </div>
          <p className="text-xs text-[#B9AA9D]">
            The connected Supabase database currently has zero active skills in{' '}
            <span className="font-mono text-[#DFE4D8]">public.skills</span>.
          </p>
        </div>
      ) : filtered.length === 0 ? (
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
                  <span
                    className={`uppercase ${
                      skill.status === 'active' ? 'text-[#6CC48E]' : 'text-[#E09F3E]'
                    }`}
                  >
                    {skill.status}
                  </span>
                </div>

                <h3 className="font-display text-lg font-semibold text-[#F7F3EC]">
                  {skill.name}
                </h3>

                <div className="font-mono text-xs text-[#DF6B3B] break-all">{skill.path}</div>

                {skill.description && (
                  <p className="text-xs text-[#B9AA9D] leading-relaxed line-clamp-3">
                    {skill.description}
                  </p>
                )}
              </div>

              <div className="pt-3 border-t border-[#382821] space-y-2">
                <div className="text-[10px] font-mono uppercase tracking-wider text-[#9C8A7C]">
                  Bound Tools
                </div>
                {skill.tools.length === 0 ? (
                  <div className="font-mono text-[11px] text-[#7C695D]">No bound tools</div>
                ) : (
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
                )}
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
