import React from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { GitBranch, GitMerge, Split } from 'lucide-react';
import type { BranchingNodeItem } from '../types/substrate';
import { DEFAULT_NODE_BODY_COLORS, defaultPortLabelsForBranching } from '../utils/graphAnnotations';
import { getContrastTextPalette } from '../utils/deadlineHighlight';

export const BRANCHING_NODE_SIZE = { width: 256, height: 144 };

export type EnrichedBranchingNodeData = BranchingNodeItem & {
  customBodyColor?: string;
};

function getPortTopPercent(index: number, total: number): number {
  return Math.round(((index + 1) / (total + 1)) * 100);
}

/**
 * MULTI-IN / SINGLE-OUT SELECTOR — Converging Funnel Multiplexer (256 x 144)
 */
export const MultiInSingleOutNode = React.memo(function MultiInSingleOutNode({
  data,
  selected,
}: NodeProps) {
  const node = data as unknown as EnrichedBranchingNodeData;
  const fill = node.customBodyColor || DEFAULT_NODE_BODY_COLORS.multi_in_single_out;
  const palette = getContrastTextPalette(fill);
  const stroke = selected ? '#67E8F9' : '#06B6D4';
  const count = Math.min(4, Math.max(2, node.portCount || 3));
  const labels =
    node.portLabels && node.portLabels.length >= count
      ? node.portLabels.slice(0, count)
      : defaultPortLabelsForBranching('multi_in_single_out', count);

  return (
    <div
      data-node-id={node.id}
      data-node-shape="branch-miso-funnel"
      className="group relative w-full h-full cursor-grab active:cursor-grabbing select-none"
    >
      <svg
        viewBox="0 0 256 144"
        className="absolute inset-0 w-full h-full pointer-events-none overflow-visible"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <path
          d="M 6 6 L 204 14 L 250 52 L 250 92 L 204 130 L 6 138 Z"
          fill={fill}
          stroke={stroke}
          strokeWidth={selected ? 2.75 : 2}
          strokeLinejoin="miter"
        />
        <path
          d="M 12 12 L 201 19 L 244 55 L 244 89 L 201 125 L 12 132 Z"
          fill="none"
          stroke={stroke}
          strokeOpacity={0.28}
          strokeWidth={1}
        />
      </svg>

      {labels.map((label, idx) => {
        const top = getPortTopPercent(idx, count);
        return (
          <React.Fragment key={`in-${idx}`}>
            <Handle
              id={`in-${idx}`}
              type="target"
              position={Position.Left}
              style={{
                top: `${top}%`,
                backgroundColor: stroke,
                borderColor: fill,
              }}
              className="!w-3.5 !h-3.5 !border-2 !rounded-full"
            />
            <span
              className="pointer-events-none absolute left-3 -translate-y-1/2 font-mono text-[9px] font-semibold uppercase tracking-tight"
              style={{ top: `${top}%`, color: stroke }}
            >
              {label}
            </span>
          </React.Fragment>
        );
      })}

      <div className="relative z-10 w-full h-full flex flex-col justify-between pl-14 pr-11 py-5">
        <div
          className="flex items-center gap-1.5 font-mono text-[10px] font-semibold uppercase tracking-wider"
          style={{ color: palette.mutedColor }}
        >
          <GitMerge className="w-3.5 h-3.5 shrink-0" style={{ color: stroke }} />
          <span className="truncate">Multi-In Selector</span>
        </div>

        <div className="my-auto">
          <h3
            className="font-display text-sm font-bold leading-snug line-clamp-2"
            style={{ color: palette.titleColor }}
          >
            {node.title}
          </h3>
        </div>

        <div
          className="pt-1 border-t font-mono text-[10px] flex items-center justify-between gap-2"
          style={{ borderColor: palette.dividerColor, color: palette.bodyColor }}
        >
          <span className="truncate">{node.rule || 'First Ready'}</span>
          <span className="shrink-0 font-semibold" style={{ color: stroke }}>
            {count}→1
          </span>
        </div>
      </div>

      <Handle
        id="out-0"
        type="source"
        position={Position.Right}
        style={{ backgroundColor: stroke, borderColor: fill }}
        className="!w-3.5 !h-3.5 !border-2 !rounded-full"
      />
    </div>
  );
});

/**
 * SINGLE-IN / MULTI-OUT SELECTOR — Diverging Prism Router (256 x 144)
 */
export const SingleInMultiOutNode = React.memo(function SingleInMultiOutNode({
  data,
  selected,
}: NodeProps) {
  const node = data as unknown as EnrichedBranchingNodeData;
  const fill = node.customBodyColor || DEFAULT_NODE_BODY_COLORS.single_in_multi_out;
  const palette = getContrastTextPalette(fill);
  const stroke = selected ? '#FDA4AF' : '#F43F5E';
  const count = Math.min(4, Math.max(2, node.portCount || 3));
  const labels =
    node.portLabels && node.portLabels.length >= count
      ? node.portLabels.slice(0, count)
      : defaultPortLabelsForBranching('single_in_multi_out', count);

  return (
    <div
      data-node-id={node.id}
      data-node-shape="branch-simo-prism"
      className="group relative w-full h-full cursor-grab active:cursor-grabbing select-none"
    >
      <svg
        viewBox="0 0 256 144"
        className="absolute inset-0 w-full h-full pointer-events-none overflow-visible"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <path
          d="M 6 52 L 52 14 L 250 6 L 250 138 L 52 130 L 6 92 Z"
          fill={fill}
          stroke={stroke}
          strokeWidth={selected ? 2.75 : 2}
          strokeLinejoin="miter"
        />
        <path
          d="M 12 55 L 55 19 L 244 12 L 244 132 L 55 125 L 12 89 Z"
          fill="none"
          stroke={stroke}
          strokeOpacity={0.28}
          strokeWidth={1}
        />
      </svg>

      <Handle
        id="in-0"
        type="target"
        position={Position.Left}
        style={{ backgroundColor: stroke, borderColor: fill }}
        className="!w-3.5 !h-3.5 !border-2 !rounded-full"
      />

      <div className="relative z-10 w-full h-full flex flex-col justify-between pl-11 pr-16 py-5">
        <div
          className="flex items-center gap-1.5 font-mono text-[10px] font-semibold uppercase tracking-wider"
          style={{ color: palette.mutedColor }}
        >
          <GitBranch className="w-3.5 h-3.5 shrink-0" style={{ color: stroke }} />
          <span className="truncate">Branch Router</span>
        </div>

        <div className="my-auto">
          <h3
            className="font-display text-sm font-bold leading-snug line-clamp-2"
            style={{ color: palette.titleColor }}
          >
            {node.title}
          </h3>
        </div>

        <div
          className="pt-1 border-t font-mono text-[10px] flex items-center justify-between gap-2"
          style={{ borderColor: palette.dividerColor, color: palette.bodyColor }}
        >
          <span className="truncate">{node.rule || 'Condition Match'}</span>
          <span className="shrink-0 font-semibold" style={{ color: stroke }}>
            1→{count}
          </span>
        </div>
      </div>

      {labels.map((label, idx) => {
        const top = getPortTopPercent(idx, count);
        return (
          <React.Fragment key={`out-${idx}`}>
            <span
              className="pointer-events-none absolute right-3 -translate-y-1/2 font-mono text-[9px] font-semibold uppercase tracking-tight text-right max-w-[56px] truncate"
              style={{ top: `${top}%`, color: stroke }}
            >
              {label}
            </span>
            <Handle
              id={`out-${idx}`}
              type="source"
              position={Position.Right}
              style={{
                top: `${top}%`,
                backgroundColor: stroke,
                borderColor: fill,
              }}
              className="!w-3.5 !h-3.5 !border-2 !rounded-full"
            />
          </React.Fragment>
        );
      })}
    </div>
  );
});

/**
 * FAN-OUT NODE — Parallel Broadcast Manifold (256 x 144)
 */
export const FanOutNode = React.memo(function FanOutNode({ data, selected }: NodeProps) {
  const node = data as unknown as EnrichedBranchingNodeData;
  const fill = node.customBodyColor || DEFAULT_NODE_BODY_COLORS.fan_out;
  const palette = getContrastTextPalette(fill);
  const stroke = selected ? '#BEF264' : '#84CC16';
  const count = Math.min(4, Math.max(2, node.portCount || 3));
  const labels =
    node.portLabels && node.portLabels.length >= count
      ? node.portLabels.slice(0, count)
      : defaultPortLabelsForBranching('fan_out', count);

  return (
    <div
      data-node-id={node.id}
      data-node-shape="branch-fan-out"
      className="group relative w-full h-full cursor-grab active:cursor-grabbing select-none"
    >
      <svg
        viewBox="0 0 256 144"
        className="absolute inset-0 w-full h-full pointer-events-none overflow-visible"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <path
          d="M 6 48 L 42 48 L 68 8 L 250 8 L 250 136 L 68 136 L 42 96 L 6 96 Z"
          fill={fill}
          stroke={stroke}
          strokeWidth={selected ? 2.75 : 2}
          strokeLinejoin="miter"
        />
        <line
          x1="64"
          y1="20"
          x2="64"
          y2="124"
          stroke={stroke}
          strokeOpacity={0.35}
          strokeWidth={2}
        />
      </svg>

      <Handle
        id="in-0"
        type="target"
        position={Position.Left}
        style={{ backgroundColor: stroke, borderColor: fill }}
        className="!w-3.5 !h-3.5 !border-2 !rounded-full"
      />

      <div className="relative z-10 w-full h-full flex flex-col justify-between pl-16 pr-16 py-4">
        <div
          className="flex items-center gap-1.5 font-mono text-[10px] font-semibold uppercase tracking-wider"
          style={{ color: palette.mutedColor }}
        >
          <Split className="w-3.5 h-3.5 shrink-0" style={{ color: stroke }} />
          <span className="truncate">Fan-Out</span>
        </div>

        <div className="my-auto">
          <h3
            className="font-display text-sm font-bold leading-snug line-clamp-2"
            style={{ color: palette.titleColor }}
          >
            {node.title}
          </h3>
        </div>

        <div
          className="pt-1 border-t font-mono text-[10px] flex items-center justify-between gap-2"
          style={{ borderColor: palette.dividerColor, color: palette.bodyColor }}
        >
          <span className="truncate">{node.rule || 'Parallel Broadcast'}</span>
          <span className="shrink-0 font-semibold" style={{ color: stroke }}>
            ×{count}
          </span>
        </div>
      </div>

      {labels.map((label, idx) => {
        const top = getPortTopPercent(idx, count);
        return (
          <React.Fragment key={`fan-${idx}`}>
            <span
              className="pointer-events-none absolute right-3 -translate-y-1/2 font-mono text-[9px] font-semibold uppercase tracking-tight text-right max-w-[56px] truncate"
              style={{ top: `${top}%`, color: stroke }}
            >
              {label}
            </span>
            <Handle
              id={`out-${idx}`}
              type="source"
              position={Position.Right}
              style={{
                top: `${top}%`,
                backgroundColor: stroke,
                borderColor: fill,
              }}
              className="!w-3.5 !h-3.5 !border-2 !rounded-full"
            />
          </React.Fragment>
        );
      })}
    </div>
  );
});
