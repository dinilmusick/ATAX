import React from 'react';
import { Palette, RotateCcw, X } from 'lucide-react';
import type { NodeColorPreferences, NodeTypeKey } from '../types/substrate';
import { DEFAULT_NODE_BODY_COLORS, NODE_COLOR_PRESETS } from '../utils/graphAnnotations';

interface GraphAppearancePopoverProps {
  open: boolean;
  onClose: () => void;
  nodeTypes: Array<{ key: NodeTypeKey; label: string }>;
  colorPrefs: NodeColorPreferences;
  onChangeTypeColor: (nodeType: NodeTypeKey, color: string) => void;
  onResetColors: () => void;
  showDeadlineLegend?: boolean;
}

const DEADLINE_LEGEND: Array<{ color: string; label: string; rule: string }> = [
  { color: '#22C55E', label: 'Green', rule: '> 50% allotted time left' },
  { color: '#EAB308', label: 'Yellow', rule: '25% – 50% time left' },
  { color: '#F97316', label: 'Orange', rule: '5% – 25% time left' },
  { color: '#EF4444', label: 'Red', rule: '≤ 5% time left or overdue' },
];

export function GraphAppearancePopover({
  open,
  onClose,
  nodeTypes,
  colorPrefs,
  onChangeTypeColor,
  onResetColors,
  showDeadlineLegend = true,
}: GraphAppearancePopoverProps) {
  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-label="Node colors and deadline highlights"
      className="absolute top-16 right-4 z-40 w-80 bg-[#1B120F] border border-[#594238] shadow-2xl rounded-sm text-[#F7F3EC] p-4 space-y-4"
    >
      <div className="flex items-center justify-between gap-2 border-b border-[#382821] pb-2.5">
        <div className="inline-flex items-center gap-2 font-mono text-xs font-bold uppercase tracking-wider text-[#DFE4D8]">
          <Palette className="w-3.5 h-3.5 text-[#DF6B3B]" />
          <span>Node Colors &amp; Deadlines</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={onResetColors}
            title="Reset default node colors"
            aria-label="Reset default node colors"
            className="inline-flex items-center gap-1 px-2 py-1 text-[10px] font-mono text-[#D8CFC2] hover:text-[#F7F3EC] hover:bg-[#2C1E19] rounded-xs cursor-pointer"
          >
            <RotateCcw className="w-3 h-3" />
            <span>Reset</span>
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close appearance panel"
            className="p-1 text-[#B9AA9D] hover:text-[#F7F3EC] hover:bg-[#2C1E19] rounded-xs cursor-pointer"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Per Node-Type Custom Body Colors */}
      <div className="space-y-3">
        <div className="font-mono text-[10px] uppercase tracking-wider text-[#B9AA9D]">
          Body Color by Node Type
        </div>
        {nodeTypes.map(({ key, label }) => {
          const current = colorPrefs.byType[key] || DEFAULT_NODE_BODY_COLORS[key];
          return (
            <div key={key} className="space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-xs font-semibold text-[#F2EBE1]">{label}</span>
                <label className="inline-flex items-center gap-2 cursor-pointer">
                  <span className="font-mono text-[10px] text-[#B9AA9D] uppercase">{current}</span>
                  <input
                    type="color"
                    aria-label={`${label} body color`}
                    value={current}
                    onChange={(e) => onChangeTypeColor(key, e.target.value)}
                    className="w-6 h-5 bg-transparent border border-[#594238] rounded-xs cursor-pointer p-0"
                  />
                </label>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                {NODE_COLOR_PRESETS.map((preset) => (
                  <button
                    key={`${key}-${preset.color}`}
                    type="button"
                    aria-label={`Set ${label} color to ${preset.label}`}
                    title={preset.label}
                    onClick={() => onChangeTypeColor(key, preset.color)}
                    className={`w-4 h-4 rounded-xs border transition-transform cursor-pointer ${
                      current.toLowerCase() === preset.color.toLowerCase()
                        ? 'border-[#F7F3EC] scale-110 ring-1 ring-[#F7F3EC]'
                        : 'border-white/25 hover:scale-105'
                    }`}
                    style={{ backgroundColor: preset.color }}
                  />
                ))}
              </div>
            </div>
          );
        })}
      </div>

      {/* Deadline Highlight Color Legend */}
      {showDeadlineLegend && (
        <div className="pt-3 border-t border-[#382821] space-y-2">
          <div className="font-mono text-[10px] uppercase tracking-wider text-[#B9AA9D]">
            Deadline Highlight Border
          </div>
          <div className="space-y-1.5">
            {DEADLINE_LEGEND.map((item) => (
              <div
                key={item.label}
                className="flex items-center justify-between gap-2 font-mono text-[11px]"
              >
                <span className="inline-flex items-center gap-2 text-[#F2EBE1]">
                  <span
                    aria-hidden="true"
                    className="w-3 h-3 rounded-xs border border-white/30 shrink-0"
                    style={{ backgroundColor: item.color }}
                  />
                  <span className="font-semibold">{item.label}</span>
                </span>
                <span className="text-[#B9AA9D] text-[10px]">{item.rule}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
