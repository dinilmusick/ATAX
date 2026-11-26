import React from 'react';
import { NodeResizer, type NodeProps, type ResizeParams } from '@xyflow/react';
import { GripHorizontal, StickyNote, Trash2 } from 'lucide-react';
import { GROUP_BOX_COLORS, STICKY_NOTE_COLORS } from '../utils/graphAnnotations';

export interface StickyNoteNodeData extends Record<string, unknown> {
  id: string;
  text: string;
  color: string;
  disableFloat?: boolean;
  onUpdateText: (id: string, text: string) => void;
  onUpdateColor: (id: string, color: string) => void;
  onDelete: (id: string) => void;
  onResizeFinish?: (id: string, width: number, height: number, x: number, y: number) => void;
}

export const StickyNoteNode = React.memo(function StickyNoteNode({
  data,
  selected,
}: NodeProps) {
  const note = data as unknown as StickyNoteNodeData;
  const bg = note.color || STICKY_NOTE_COLORS[0].hex;

  return (
    <div
      data-node-id={note.id}
      data-testid={`sticky-note-${note.id}`}
      className="relative w-full h-full flex flex-col"
      style={{
        backgroundColor: bg,
        color: '#18120F',
        clipPath: 'polygon(0 0, calc(100% - 18px) 0, 100% 18px, 100% 100%, 0 100%)',
        outline: selected ? '2px solid #F7F3EC' : '1px solid rgba(24, 18, 15, 0.28)',
      }}
    >
      <NodeResizer
        isVisible={selected}
        minWidth={170}
        minHeight={130}
        lineStyle={{ borderColor: '#18120F', borderWidth: 1 }}
        handleStyle={{
          width: 8,
          height: 8,
          backgroundColor: '#18120F',
          border: '1px solid #F7F3EC',
        }}
        onResizeEnd={(_, params: ResizeParams) => {
          note.onResizeFinish?.(note.id, params.width, params.height, params.x, params.y);
        }}
      />

      {/* Folded corner highlight */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute top-0 right-0 w-[18px] h-[18px]"
        style={{
          background: 'linear-gradient(225deg, rgba(24,18,15,0.22) 50%, rgba(255,255,255,0.35) 50%)',
        }}
      />

      {/* Header */}
      <div className="flex items-center justify-between gap-2 px-2.5 pt-2 pb-1.5 pr-6 border-b border-[#18120F]/15 cursor-grab active:cursor-grabbing">
        <span className="inline-flex items-center gap-1 font-mono text-[10px] font-bold uppercase tracking-wider text-[#2C221D]">
          <StickyNote className="w-3 h-3 shrink-0" />
          <span>Note</span>
        </span>
        <div className="nodrag flex items-center gap-1">
          {STICKY_NOTE_COLORS.map((swatch) => (
            <button
              key={swatch.hex}
              type="button"
              aria-label={`Set sticky note color ${swatch.label}`}
              title={swatch.label}
              onClick={() => note.onUpdateColor(note.id, swatch.hex)}
              className={`w-3 h-3 rounded-full border transition-transform cursor-pointer ${
                bg.toLowerCase() === swatch.hex.toLowerCase()
                  ? 'border-[#18120F] scale-125'
                  : 'border-[#18120F]/35 hover:scale-110'
              }`}
              style={{ backgroundColor: swatch.hex }}
            />
          ))}
          <button
            type="button"
            aria-label={`Delete sticky note ${note.id}`}
            title="Delete sticky note"
            onClick={() => note.onDelete(note.id)}
            className="ml-1 p-0.5 text-[#3B2A23] hover:text-[#B91C1C] transition-colors cursor-pointer"
          >
            <Trash2 className="w-3 h-3" />
          </button>
        </div>
      </div>

      {/* Editable Body */}
      <textarea
        aria-label="Sticky note text"
        value={note.text}
        onChange={(e) => note.onUpdateText(note.id, e.target.value)}
        placeholder="Write note..."
        className="nodrag nowheel flex-1 w-full resize-none bg-transparent px-2.5 py-2 font-sans text-xs font-medium leading-relaxed text-[#18120F] placeholder:text-[#4A3E36]/70 focus:outline-none"
      />
    </div>
  );
});

export interface GroupBoxNodeData extends Record<string, unknown> {
  id: string;
  title: string;
  color: string;
  disableFloat?: boolean;
  onUpdateTitle: (id: string, title: string) => void;
  onUpdateColor: (id: string, color: string) => void;
  onDelete: (id: string) => void;
  onResizeFinish?: (id: string, width: number, height: number, x: number, y: number) => void;
}

function hexToRgba(hex: string, alpha: number): string {
  const clean = hex.trim().replace(/^#/, '');
  if (!/^[0-9a-f]{6}$/i.test(clean)) return `rgba(224, 72, 25, ${alpha})`;
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export const GroupBoxNode = React.memo(function GroupBoxNode({ data, selected }: NodeProps) {
  const box = data as unknown as GroupBoxNodeData;
  const accent = box.color || GROUP_BOX_COLORS[0].hex;

  return (
    <div
      data-node-id={box.id}
      data-testid={`group-box-${box.id}`}
      className="relative w-full h-full rounded-sm flex flex-col"
      style={{
        backgroundColor: hexToRgba(accent, 0.08),
        border: `${selected ? '2px' : '1.5px'} dashed ${accent}`,
        boxShadow: selected ? `0 0 0 2px ${hexToRgba(accent, 0.28)}` : 'none',
      }}
    >
      <NodeResizer
        isVisible={selected}
        minWidth={260}
        minHeight={180}
        lineStyle={{ borderColor: accent, borderWidth: 1.5 }}
        handleStyle={{
          width: 9,
          height: 9,
          backgroundColor: accent,
          border: '1px solid #140D0B',
        }}
        onResizeEnd={(_, params: ResizeParams) => {
          box.onResizeFinish?.(box.id, params.width, params.height, params.x, params.y);
        }}
      />

      {/* Top Group Header Bar */}
      <div
        className="flex items-center justify-between gap-2 px-3 py-1.5 border-b cursor-grab active:cursor-grabbing"
        style={{
          backgroundColor: hexToRgba(accent, 0.16),
          borderColor: hexToRgba(accent, 0.45),
        }}
      >
        <div className="flex items-center gap-1.5 min-w-0 flex-1">
          <GripHorizontal className="w-3.5 h-3.5 shrink-0" style={{ color: accent }} />
          <input
            type="text"
            aria-label="Grouping box title"
            value={box.title}
            onChange={(e) => box.onUpdateTitle(box.id, e.target.value)}
            className="nodrag nowheel w-full bg-transparent font-mono text-xs font-bold uppercase tracking-wider text-[#F7F3EC] focus:outline-none focus:underline"
          />
        </div>

        <div className="nodrag flex items-center gap-1 shrink-0">
          {GROUP_BOX_COLORS.map((swatch) => (
            <button
              key={swatch.hex}
              type="button"
              aria-label={`Set group box color ${swatch.label}`}
              title={swatch.label}
              onClick={() => box.onUpdateColor(box.id, swatch.hex)}
              className={`w-3 h-3 rounded-full border transition-transform cursor-pointer ${
                accent.toLowerCase() === swatch.hex.toLowerCase()
                  ? 'border-[#F7F3EC] scale-125'
                  : 'border-white/30 hover:scale-110'
              }`}
              style={{ backgroundColor: swatch.hex }}
            />
          ))}
          <button
            type="button"
            aria-label={`Delete grouping box ${box.id}`}
            title="Delete grouping box"
            onClick={() => box.onDelete(box.id)}
            className="ml-1 p-0.5 text-[#D8CFC2] hover:text-[#F87171] transition-colors cursor-pointer"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
});
