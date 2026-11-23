import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Background,
  BackgroundVariant,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import {
  AlertTriangle,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Flag,
  GitBranch,
  Loader2,
  Maximize2,
  Pin,
  RotateCcw,
  Target,
  Terminal,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import type {
  GoalGraphNodeData,
  TaskGraphNodeData,
  TaskOccupancyInfo,
  VisionGoalTaskEdge,
  VisionGraphNodeData,
  VisionsGoalsSubstrateResponse,
} from '../types/substrate';
import { buildVisionsGoalsGraph, formatContextUsage } from '../utils/graphData';
import { useFloatyForceLayout } from '../hooks/useFloatyForceLayout';
import { IconButton } from './IconButton';
import { NodeDetailProvider, useNodeDetail } from '../context/NodeDetailContext';

interface VisionsGoalsGraphViewProps {
  refreshTick?: number;
  onLoadingChange?: (loading: boolean) => void;
}

type VisionNodeData = VisionGraphNodeData & { expanded?: boolean };
type GoalNodeData = GoalGraphNodeData & { expanded?: boolean };

type SelectedGraphItem =
  | { kind: 'vision'; data: VisionGraphNodeData }
  | { kind: 'goal'; data: GoalGraphNodeData }
  | { kind: 'task'; data: TaskGraphNodeData };

function leaseBadgeClass(state: TaskOccupancyInfo['leaseState']): string {
  switch (state) {
    case 'lease_valid':
      return 'text-[#6CC48E] border-[#3E7A56] bg-[#13241A]';
    case 'lease_expired':
      return 'text-[#E04819] border-[#8C3B28] bg-[#261410]';
    case 'unknown':
      return 'text-[#E09F3E] border-[#8C5B23] bg-[#23190E]';
    default:
      return 'text-[#B9AA9D] border-[#3F2E27] bg-[#1A110E]';
  }
}

function leaseLabel(state: TaskOccupancyInfo['leaseState']): string {
  switch (state) {
    case 'lease_valid':
      return 'Lease Valid';
    case 'lease_expired':
      return 'Lease Expired';
    case 'unknown':
      return 'Lease Unknown';
    default:
      return 'Unclaimed';
  }
}

function VisionNode({ data, selected }: NodeProps) {
  const vision = data as unknown as VisionNodeData;
  const isContainerExpanded = Boolean(vision.expanded);
  const { isExpanded, isPinned, toggleExpand, togglePin } = useNodeDetail(vision.id);

  if (isContainerExpanded) {
    return (
      <div
        data-node-id={vision.id}
        className={`w-full h-full rounded-md border-2 transition-colors duration-150 flex flex-col shadow-xl ${
          selected
            ? 'bg-[#E5EAE0] border-[#2C4A35] ring-2 ring-[#2C4A35]'
            : 'bg-[#DFE4D8] border-[#5A7356] hover:border-[#2C4A35]'
        }`}
      >
        <Handle
          type="target"
          position={Position.Left}
          className="!w-3 !h-3 !bg-[#2C4A35] !border-2 !border-[#E5EAE0] !rounded-full"
        />
        <Handle
          type="source"
          position={Position.Right}
          className="!w-3 !h-3 !bg-[#2C4A35] !border-2 !border-[#E5EAE0] !rounded-full"
        />

        <div className="bg-[#2C4A35] text-[#F2EBE1] px-4 py-3 border-b border-[#43634E] flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <span className="font-mono text-[9px] uppercase tracking-widest px-1.5 py-0.5 rounded-xs bg-[#1E3324] text-[#8FE3AB] font-bold">
              VISION
            </span>
            <Target className="w-4 h-4 text-[#8FE3AB] shrink-0" />
            <h3 className="font-display text-sm font-bold text-[#F2EBE1] truncate">
              {vision.title}
            </h3>
          </div>
          <div className="inline-flex items-center gap-1 font-mono text-[10px] font-semibold text-[#8FE3AB] shrink-0">
            <ChevronDown className="w-3.5 h-3.5" />
            <span>{vision.goalsCount} goals</span>
          </div>
        </div>

        <div className="flex-1" />
      </div>
    );
  }

  return (
    <div
      data-node-id={vision.id}
      data-expanded-node={isExpanded}
      className={`w-full h-full rounded-md border-2 transition-all duration-150 relative shadow-lg ${
        isExpanded
          ? 'bg-[#EAEFE3] text-[#18120F] border-[#2C4A35] ring-2 ring-[#2C4A35] z-40'
          : selected
          ? 'bg-[#E5EAE0] text-[#18120F] border-[#2C4A35] ring-2 ring-[#2C4A35]'
          : 'bg-[#DFE4D8] text-[#18120F] border-[#6E7E62] hover:border-[#2C4A35]'
      }`}
    >
      <Handle
        type="target"
        position={Position.Left}
        className="!w-3 !h-3 !bg-[#2C4A35] !border-2 !border-[#DFE4D8] !rounded-full"
      />

      <div className="flex items-center justify-between gap-2.5 px-3.5 h-full">
        <div className="flex items-center gap-2.5 min-w-0">
          <span className="font-mono text-[9px] uppercase tracking-widest px-1.5 py-0.5 rounded-xs bg-[#2C4A35] text-[#8FE3AB] font-bold shrink-0">
            VISION
          </span>
          <Target className="w-4 h-4 text-[#2C4A35] shrink-0" />
          <span className="font-display text-sm font-bold leading-tight text-[#18120F] truncate">
            {vision.title}
          </span>
        </div>
        <button
          type="button"
          aria-label={`Expand details for ${vision.title}`}
          onClick={(e) => {
            e.stopPropagation();
            toggleExpand();
          }}
          className="nodrag nopan p-1 rounded-xs text-[#4A5D45] hover:text-[#18120F] hover:bg-[#C5CBBF] transition-colors shrink-0 cursor-pointer"
        >
          <ChevronDown className="w-3.5 h-3.5 pointer-events-none" />
        </button>
      </div>

      {isExpanded && (
        <div className="nodrag nopan absolute top-0 left-0 w-full z-50 rounded-md border-2 border-[#2C4A35] bg-[#DFE4D8] text-[#18120F] shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-100">
          <div className="flex items-center justify-between gap-2 px-3.5 py-3 bg-[#2C4A35] text-[#F2EBE1] border-b border-[#43634E]">
            <div className="flex items-center gap-2 min-w-0">
              <span className="font-mono text-[9px] uppercase tracking-widest px-1.5 py-0.5 rounded-xs bg-[#1E3324] text-[#8FE3AB] font-bold">
                VISION
              </span>
              <Target className="w-4 h-4 text-[#8FE3AB] shrink-0 pointer-events-none" />
              <span className="font-display text-sm font-bold truncate text-[#F2EBE1]">
                {vision.title}
              </span>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <button
                type="button"
                aria-label={
                  isPinned
                    ? `Unpin ${vision.title} (auto-minimises on outside click)`
                    : `Pin ${vision.title} (stays open on outside click)`
                }
                aria-pressed={isPinned}
                onClick={(e) => {
                  e.stopPropagation();
                  togglePin();
                }}
                className={`nodrag nopan p-1 rounded-xs transition-colors cursor-pointer ${
                  isPinned
                    ? 'bg-[#8FE3AB] text-[#18120F] border border-[#2C4A35]'
                    : 'text-[#C5CBBF] hover:text-[#F2EBE1] hover:bg-[#395D47] border border-transparent'
                }`}
              >
                <Pin className={`w-3.5 h-3.5 pointer-events-none ${isPinned ? 'fill-current' : ''}`} />
              </button>
              <button
                type="button"
                aria-label={`Minimise ${vision.title}`}
                onClick={(e) => {
                  e.stopPropagation();
                  toggleExpand();
                }}
                className="nodrag nopan p-1 rounded-xs text-[#C5CBBF] hover:text-[#F2EBE1] hover:bg-[#395D47] transition-colors cursor-pointer"
              >
                <ChevronUp className="w-3.5 h-3.5 pointer-events-none" />
              </button>
            </div>
          </div>

          <div className="p-4 space-y-2.5 text-xs">
            <div className="flex items-center justify-between gap-2 text-[11px] font-mono text-[#4A5D45]">
              <span>KEY: {vision.readableKey}</span>
              <span className="uppercase font-semibold text-[#2C4A35]">
                {vision.status.replace('_', ' ')}
              </span>
            </div>

            <p className="text-xs text-[#2C3829] leading-relaxed">
              {vision.description || 'No description recorded.'}
            </p>

            <div className="pt-2 border-t border-[#C4CABD] flex items-center justify-between text-[11px] font-mono text-[#4A5D45]">
              <span className="truncate">
                {vision.targetLabel ? `${vision.targetType}: ${vision.targetLabel}` : vision.targetType}
              </span>
              <span className="inline-flex items-center gap-1 font-semibold text-[#18120F] shrink-0">
                <ChevronRight className="w-3 h-3 text-[#2C4A35]" />
                {vision.goalsCount} goals
              </span>
            </div>
          </div>
        </div>
      )}

      <Handle
        type="source"
        position={Position.Right}
        className="!w-3 !h-3 !bg-[#2C4A35] !border-2 !border-[#DFE4D8] !rounded-full"
      />
    </div>
  );
}

function GoalNode({ data, selected }: NodeProps) {
  const goal = data as unknown as GoalNodeData;
  const isContainerExpanded = Boolean(goal.expanded);
  const { isExpanded, isPinned, toggleExpand, togglePin } = useNodeDetail(goal.id);

  if (isContainerExpanded) {
    return (
      <div
        data-node-id={goal.id}
        className={`w-full h-full rounded-md border-2 transition-colors duration-150 flex flex-col shadow-xl ${
          selected
            ? 'bg-[#3A1E17] border-[#E04819] ring-2 ring-[#E04819]'
            : 'bg-[#28130E] border-[#8C3B28] hover:border-[#E04819]'
        }`}
      >
        <Handle
          type="target"
          position={Position.Left}
          className="!w-3 !h-3 !bg-[#E04819] !border-2 !border-[#28130E] !rounded-full"
        />
        <Handle
          type="source"
          position={Position.Right}
          className="!w-3 !h-3 !bg-[#E04819] !border-2 !border-[#28130E] !rounded-full"
        />

        <div className="bg-[#C83214] text-[#F7F3EC] px-4 py-3 border-b border-[#8C220E] flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <span className="font-mono text-[9px] uppercase tracking-widest px-1.5 py-0.5 rounded-xs bg-[#52170B] text-[#FFB399] font-bold">
              GOAL
            </span>
            <Flag className="w-4 h-4 text-[#FFB399] shrink-0" />
            <h3 className="font-display text-sm font-bold text-[#F7F3EC] truncate">
              {goal.title}
            </h3>
          </div>
          <div className="inline-flex items-center gap-1 font-mono text-[10px] font-semibold text-[#FFB399] shrink-0">
            <ChevronDown className="w-3.5 h-3.5" />
            <span>{goal.tasksCount} tasks</span>
          </div>
        </div>

        <div className="flex-1" />
      </div>
    );
  }

  return (
    <div
      data-node-id={goal.id}
      data-expanded-node={isExpanded}
      className={`w-full h-full rounded-md border-2 transition-all duration-150 relative shadow-lg ${
        isExpanded
          ? 'bg-[#3A1E17] text-[#F7F3EC] border-[#E04819] ring-2 ring-[#E04819] z-40'
          : selected
          ? 'bg-[#321A13] text-[#F7F3EC] border-[#E04819] ring-2 ring-[#E04819]'
          : 'bg-[#28130E] text-[#F7F3EC] border-[#8C3B28] hover:border-[#E04819]'
      }`}
    >
      <Handle
        type="target"
        position={Position.Left}
        className="!w-3 !h-3 !bg-[#E04819] !border-2 !border-[#28130E] !rounded-full"
      />

      <div className="flex items-center justify-between gap-2.5 px-3.5 h-full">
        <div className="flex items-center gap-2.5 min-w-0">
          <span className="font-mono text-[9px] uppercase tracking-widest px-1.5 py-0.5 rounded-xs bg-[#C83214] text-[#F7F3EC] font-bold shrink-0">
            GOAL
          </span>
          <Flag className="w-4 h-4 text-[#E04819] shrink-0" />
          <span className="font-display text-sm font-bold leading-tight text-[#F7F3EC] truncate">
            {goal.title}
          </span>
        </div>
        <button
          type="button"
          aria-label={`Expand details for ${goal.title}`}
          onClick={(e) => {
            e.stopPropagation();
            toggleExpand();
          }}
          className="nodrag nopan p-1 rounded-xs text-[#B9AA9D] hover:text-[#F7F3EC] hover:bg-[#522E25] transition-colors shrink-0 cursor-pointer"
        >
          <ChevronDown className="w-3.5 h-3.5 pointer-events-none" />
        </button>
      </div>

      {isExpanded && (
        <div className="nodrag nopan absolute top-0 left-0 w-full z-50 rounded-md border-2 border-[#E04819] bg-[#22100C] text-[#F7F3EC] shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-100">
          <div className="flex items-center justify-between gap-2 px-3.5 py-3 bg-[#C83214] text-[#F7F3EC] border-b border-[#8C220E]">
            <div className="flex items-center gap-2 min-w-0">
              <span className="font-mono text-[9px] uppercase tracking-widest px-1.5 py-0.5 rounded-xs bg-[#52170B] text-[#FFB399] font-bold">
                GOAL
              </span>
              <Flag className="w-4 h-4 text-[#FFB399] shrink-0 pointer-events-none" />
              <span className="font-display text-sm font-bold truncate text-[#F7F3EC]">
                {goal.title}
              </span>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <button
                type="button"
                aria-label={
                  isPinned
                    ? `Unpin ${goal.title} (auto-minimises on outside click)`
                    : `Pin ${goal.title} (stays open on outside click)`
                }
                aria-pressed={isPinned}
                onClick={(e) => {
                  e.stopPropagation();
                  togglePin();
                }}
                className={`nodrag nopan p-1 rounded-xs transition-colors cursor-pointer ${
                  isPinned
                    ? 'bg-[#FFB399] text-[#22100C] border border-[#C83214]'
                    : 'text-[#E6DDD1] hover:text-[#F7F3EC] hover:bg-[#A82A11] border border-transparent'
                }`}
              >
                <Pin className={`w-3.5 h-3.5 pointer-events-none ${isPinned ? 'fill-current' : ''}`} />
              </button>
              <button
                type="button"
                aria-label={`Minimise ${goal.title}`}
                onClick={(e) => {
                  e.stopPropagation();
                  toggleExpand();
                }}
                className="nodrag nopan p-1 rounded-xs text-[#E6DDD1] hover:text-[#F7F3EC] hover:bg-[#A82A11] transition-colors cursor-pointer"
              >
                <ChevronUp className="w-3.5 h-3.5 pointer-events-none" />
              </button>
            </div>
          </div>

          <div className="p-4 space-y-3 text-xs">
            <div className="flex items-center justify-between gap-2 text-[11px] font-mono text-[#B9AA9D]">
              <span className="text-[#FFB399]">KEY: {goal.readableKey}</span>
              <span className="uppercase font-semibold text-[#E6DDD1]">
                {goal.status}
              </span>
            </div>

            <div className="space-y-1">
              <div className="flex items-center justify-between text-[11px] font-mono text-[#B9AA9D]">
                <span>
                  {goal.maxIterations > 0
                    ? `Loop ${goal.currentIteration}/${goal.maxIterations}`
                    : `Iteration ${goal.currentIteration}`}
                </span>
                <span>{goal.progress}%</span>
              </div>
              <div className="w-full h-2 bg-[#1A0E0B] rounded-full overflow-hidden border border-[#522E25]">
                <div
                  className={`h-full ${
                    goal.status === 'verified' || goal.status === 'completed'
                      ? 'bg-[#6CC48E]'
                      : 'bg-[#C83214]'
                  }`}
                  style={{ width: `${goal.progress}%` }}
                />
              </div>
            </div>

            <div className="pt-2 border-t border-[#522E25] flex items-center justify-between text-[11px] font-mono text-[#A89688]">
              <span>
                Priority {goal.priority.toFixed(2)} · Notoriety {goal.blockerNotoriety}
              </span>
              <span className="inline-flex items-center gap-1 text-[#FF7A50] font-semibold">
                <ChevronRight className="w-3 h-3" />
                {goal.tasksCount} tasks
              </span>
            </div>
          </div>
        </div>
      )}

      <Handle
        type="source"
        position={Position.Right}
        className="!w-3 !h-3 !bg-[#E04819] !border-2 !border-[#28130E] !rounded-full"
      />
    </div>
  );
}

function TaskNode({ data, selected }: NodeProps) {
  const task = data as unknown as TaskGraphNodeData;
  const ctx = task.contextLimit ? formatContextUsage(task.contextLimit) : null;
  const { isExpanded, isPinned, toggleExpand, togglePin } = useNodeDetail(task.id);

  return (
    <div
      data-node-id={task.id}
      data-expanded-node={isExpanded}
      className={`w-full h-full rounded-sm border-2 transition-all duration-150 relative overflow-hidden shadow-md ${
        isExpanded
          ? 'bg-[#18100E] text-[#F7F3EC] border-[#DF6B3B] ring-2 ring-[#DF6B3B] z-40'
          : selected
          ? 'bg-[#160E0C] text-[#F7F3EC] border-[#DF6B3B] ring-2 ring-[#DF6B3B]'
          : 'bg-[#120B09] text-[#F7F3EC] border-[#3B261E] hover:border-[#DF6B3B]'
      }`}
    >
      <Handle
        type="target"
        position={Position.Left}
        className="!w-2.5 !h-2.5 !bg-[#DF6B3B] !border !border-[#120B09] !rounded-full"
      />

      <div className="flex items-center justify-between gap-2 px-3 h-full">
        <div className="flex items-center gap-2 min-w-0">
          <span className="font-mono text-[9px] uppercase tracking-widest px-1.5 py-0.5 rounded-xs bg-[#2B1D18] text-[#F0946E] font-bold shrink-0">
            TASK
          </span>
          <Terminal className="w-3.5 h-3.5 text-[#DF6B3B] shrink-0" />
          <span className="font-display text-xs font-semibold leading-tight text-[#F7F3EC] truncate">
            {task.title}
          </span>
        </div>
        <button
          type="button"
          aria-label={`Expand task details for ${task.title}`}
          onClick={(e) => {
            e.stopPropagation();
            toggleExpand();
          }}
          className="nodrag nopan p-1 rounded-xs text-[#9C8A7C] hover:text-[#F7F3EC] hover:bg-[#2C1D18] transition-colors shrink-0 cursor-pointer"
        >
          <ChevronDown className="w-3 h-3 pointer-events-none" />
        </button>
      </div>

      {isExpanded && (
        <div className="nodrag nopan absolute top-0 left-0 w-full z-50 rounded-sm border-2 border-[#DF6B3B] bg-[#140D0B] text-[#F7F3EC] shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-100">
          <div className="flex items-center justify-between gap-2 px-3 py-2.5 bg-[#2B1D18] text-[#F7F3EC] border-b border-[#432C24]">
            <div className="flex items-center gap-2 min-w-0">
              <span className="font-mono text-[9px] uppercase tracking-widest px-1.5 py-0.5 rounded-xs bg-[#42261C] text-[#F0946E] font-bold">
                TASK
              </span>
              <Terminal className="w-3.5 h-3.5 text-[#F0946E] shrink-0 pointer-events-none" />
              <span className="font-display text-sm font-semibold truncate text-[#F7F3EC]">
                {task.title}
              </span>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <button
                type="button"
                aria-label={
                  isPinned
                    ? `Unpin ${task.title} (auto-minimises on outside click)`
                    : `Pin ${task.title} (stays open on outside click)`
                }
                aria-pressed={isPinned}
                onClick={(e) => {
                  e.stopPropagation();
                  togglePin();
                }}
                className={`nodrag nopan p-1 rounded-xs transition-colors cursor-pointer ${
                  isPinned
                    ? 'bg-[#DF6B3B] text-[#120B09] border border-[#DF6B3B]'
                    : 'text-[#A89688] hover:text-[#F7F3EC] hover:bg-[#2C1D18] border border-transparent'
                }`}
              >
                <Pin className={`w-3.5 h-3.5 pointer-events-none ${isPinned ? 'fill-current' : ''}`} />
              </button>
              <button
                type="button"
                aria-label={`Minimise ${task.title}`}
                onClick={(e) => {
                  e.stopPropagation();
                  toggleExpand();
                }}
                className="nodrag nopan p-1 rounded-xs text-[#A89688] hover:text-[#F7F3EC] hover:bg-[#2C1D18] transition-colors cursor-pointer"
              >
                <ChevronUp className="w-3.5 h-3.5 pointer-events-none" />
              </button>
            </div>
          </div>

          <div className="p-3.5 space-y-2.5 text-xs max-h-[360px] overflow-y-auto">
            <div className="flex items-center justify-between gap-2 text-[11px] font-mono">
              <span className="text-[#F0946E] font-semibold truncate">
                KEY: {task.readableKey}
              </span>
              <span className="text-[#B9AA9D] uppercase shrink-0 px-2 py-0.5 bg-[#241712] rounded-xs">
                {task.status}
              </span>
            </div>

            <div className="flex items-center justify-between gap-2 text-[10px] font-mono">
              <span className={`px-2 py-0.5 border rounded-xs ${leaseBadgeClass(task.occupancy.leaseState)}`}>
                {leaseLabel(task.occupancy.leaseState)}
              </span>
              <span className="text-[#A89688] truncate">
                Verif: {task.verificationStatus}
              </span>
            </div>

            {task.occupancy.agentDisplayLabel && (
              <div className="text-[10px] font-mono text-[#DFE4D8] truncate">
                Holder: {task.occupancy.agentDisplayLabel}
              </div>
            )}

            <div className="space-y-1">
              <div className="text-[10px] font-mono uppercase tracking-wider text-[#9C8A7C]">
                Eval Script
              </div>
              <pre className="bg-[#0A0605] border border-[#2B1D18] px-2.5 py-1.5 text-[10px] font-mono text-[#F0946E] whitespace-pre-wrap break-all leading-relaxed">
                {task.evalScript || 'No evaluation script recorded.'}
              </pre>
            </div>

            <div className="grid grid-cols-2 gap-2 text-[10px] font-mono bg-[#0F0907] border border-[#2B1D18] p-2">
              <div className="min-w-0">
                <div className="uppercase tracking-wider text-[#9C8A7C] mb-1">Inputs</div>
                {task.inputs.length === 0 ? (
                  <span className="text-[#7C695D]">None</span>
                ) : (
                  <ul className="space-y-0.5 text-[#D8CFC2]">
                    {task.inputs.map((inp) => (
                      <li key={inp} className="truncate">
                        {inp}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div className="min-w-0 border-l border-[#2B1D18] pl-2">
                <div className="uppercase tracking-wider text-[#9C8A7C] mb-1">Outputs</div>
                {task.outputs.length === 0 ? (
                  <span className="text-[#7C695D]">None</span>
                ) : (
                  <ul className="space-y-0.5 text-[#DFE4D8]">
                    {task.outputs.map((out) => (
                      <li key={out} className="truncate">
                        {out}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>

            <div className="space-y-1">
              <div className="text-[10px] font-mono uppercase tracking-wider text-[#9C8A7C]">
                Tools Available
              </div>
              {task.toolsAvailable.length === 0 ? (
                <div className="font-mono text-[10px] text-[#7C695D]">None specified</div>
              ) : (
                <div className="flex flex-wrap items-center gap-1.5 font-mono text-[10px] text-[#E6DDD1]">
                  {task.toolsAvailable.map((tool, idx) => (
                    <React.Fragment key={tool}>
                      <span className="bg-[#241712] border border-[#3B261E] px-1.5 py-0.5 rounded-xs text-[#F0946E]">
                        {tool}
                      </span>
                      {idx < task.toolsAvailable.length - 1 && (
                        <span className="text-[#6B5A4E]" aria-hidden="true">
                          ·
                        </span>
                      )}
                    </React.Fragment>
                  ))}
                </div>
              )}
            </div>

            <div className="pt-2 border-t border-[#2B1D18] space-y-1">
              <div className="flex items-center justify-between text-[10px] font-mono">
                <span className="uppercase tracking-wider text-[#9C8A7C]">Context Budget</span>
                {ctx ? (
                  <span className="text-[#E6DDD1]">
                    {ctx.usedLabel} / {ctx.maxLabel} ({ctx.percent}%)
                  </span>
                ) : (
                  <span className="text-[#7C695D]">Not configured</span>
                )}
              </div>
              {ctx && (
                <div className="w-full h-2 bg-[#0A0605] rounded-full overflow-hidden border border-[#2B1D18]">
                  <div
                    className={`h-full ${ctx.percent >= 75 ? 'bg-[#E04819]' : 'bg-[#DF6B3B]'}`}
                    style={{ width: `${ctx.percent}%` }}
                  />
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      <Handle
        type="source"
        position={Position.Right}
        className="!w-2.5 !h-2.5 !bg-[#DF6B3B] !border !border-[#120B09] !rounded-full"
      />
    </div>
  );
}

const nodeTypes = {
  visionNode: VisionNode,
  goalNode: GoalNode,
  taskNode: TaskNode,
};

function VisionsGoalsGraphCanvas({ refreshTick = 0, onLoadingChange }: VisionsGoalsGraphViewProps) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [substrateData, setSubstrateData] = useState<VisionsGoalsSubstrateResponse | null>(null);

  const [expandedVisionIds, setExpandedVisionIds] = useState<string[]>([]);
  const [expandedGoalIds, setExpandedGoalIds] = useState<string[]>([]);
  const [selectedItem, setSelectedItem] = useState<SelectedGraphItem | null>(null);
  const [isBreadcrumbPinned, setIsBreadcrumbPinned] = useState(false);

  const { zoomIn, zoomOut, fitView } = useReactFlow();

  const fetchData = useCallback(async () => {
    setLoading(true);
    onLoadingChange?.(true);
    setError(null);
    try {
      const res = await fetch('/api/substrate/visions-goals');
      if (!res.ok) {
        throw new Error(`Failed to load Visions & Goals substrate (${res.status} ${res.statusText})`);
      }
      const json: VisionsGoalsSubstrateResponse = await res.json();
      setSubstrateData(json);

      const initialVisions = json.visions.map((v) => v.id);
      const initialGoals = json.goals.map((g) => g.id);
      setExpandedVisionIds(initialVisions);
      setExpandedGoalIds(initialGoals);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
      onLoadingChange?.(false);
    }
  }, [onLoadingChange]);

  useEffect(() => {
    fetchData();
  }, [fetchData, refreshTick]);

  const initialGraph = useMemo(() => {
    if (!substrateData) return { nodes: [], edges: [] };
    return buildVisionsGoalsGraph({
      visions: substrateData.visions,
      goals: substrateData.goals,
      tasks: substrateData.tasks,
      edges: substrateData.edges,
      expandedVisionIds: new Set(expandedVisionIds),
      expandedGoalIds: new Set(expandedGoalIds),
    });
  }, [substrateData, expandedVisionIds, expandedGoalIds]);

  const [nodes, setNodes, onNodesChange] = useNodesState(initialGraph.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialGraph.edges);

  useEffect(() => {
    setNodes(initialGraph.nodes);
    setEdges(initialGraph.edges);
  }, [initialGraph, setNodes, setEdges]);

  const {
    onNodeDragStart,
    onNodeDrag,
    onNodeDragStop,
    onNodeMouseEnter,
    onNodeMouseLeave,
  } = useFloatyForceLayout({
    baseNodes: initialGraph.nodes,
    edges,
    setNodes,
    enabled: true,
    amplitude: 4.2,
  });

  const clickTimerRef = useRef<number | null>(null);

  const handleNodeClick = useCallback((_: React.MouseEvent, node: Node) => {
    if (clickTimerRef.current !== null) {
      window.clearTimeout(clickTimerRef.current);
      clickTimerRef.current = null;
    }
    clickTimerRef.current = window.setTimeout(() => {
      if (!substrateData) return;
      if (node.type === 'visionNode') {
        const found = substrateData.visions.find((v) => v.id === node.id);
        if (found) setSelectedItem({ kind: 'vision', data: found });
      } else if (node.type === 'goalNode') {
        const found = substrateData.goals.find((g) => g.id === node.id);
        if (found) setSelectedItem({ kind: 'goal', data: found });
      } else if (node.type === 'taskNode') {
        const found = substrateData.tasks.find((t) => t.id === node.id);
        if (found) setSelectedItem({ kind: 'task', data: found });
      }
    }, 210);
  }, [substrateData]);

  const handleNodeDoubleClick = useCallback((_: React.MouseEvent, node: Node) => {
    if (clickTimerRef.current !== null) {
      window.clearTimeout(clickTimerRef.current);
      clickTimerRef.current = null;
    }
    if (node.type === 'visionNode') {
      setExpandedVisionIds((prev) =>
        prev.includes(node.id) ? prev.filter((id) => id !== node.id) : [...prev, node.id]
      );
    } else if (node.type === 'goalNode') {
      setExpandedGoalIds((prev) =>
        prev.includes(node.id) ? prev.filter((id) => id !== node.id) : [...prev, node.id]
      );
    }
  }, []);

  // Derive active items for breadcrumb navigation
  const activeVision = useMemo(() => {
    if (selectedItem?.kind === 'vision') return selectedItem.data;
    if (selectedItem?.kind === 'goal' && substrateData) {
      return substrateData.visions.find((v) => v.id === selectedItem.data.visionId) || null;
    }
    return null;
  }, [selectedItem, substrateData]);

  const activeGoal = useMemo(() => {
    if (selectedItem?.kind === 'goal') return selectedItem.data;
    if (selectedItem?.kind === 'task' && substrateData) {
      return substrateData.goals.find((g) => g.id === selectedItem.data.goalId) || null;
    }
    return null;
  }, [selectedItem, substrateData]);

  const activeTask = useMemo(() => {
    if (selectedItem?.kind === 'task') return selectedItem.data;
    return null;
  }, [selectedItem]);

  const breadcrumbs = useMemo(() => {
    const crumbs: Array<{
      id: string;
      label: string;
      icon?: React.ComponentType<{ className?: string }>;
      onClick?: () => void;
      isLeaf: boolean;
    }> = [
      {
        id: 'root',
        label: 'Visions & Goals',
        icon: Target,
        isLeaf: !activeVision,
        onClick: () => {
          setSelectedItem(null);
          fitView({ padding: 0.18, duration: 220 });
        },
      },
    ];

    if (activeVision) {
      crumbs.push({
        id: activeVision.id,
        label: activeVision.title,
        isLeaf: !activeGoal,
        onClick: () => {
          setSelectedItem({ kind: 'vision', data: activeVision });
          fitView({ nodes: [{ id: activeVision.id }], duration: 220, maxZoom: 1.1 });
        },
      });
    }

    if (activeGoal) {
      crumbs.push({
        id: activeGoal.id,
        label: activeGoal.title,
        isLeaf: !activeTask,
        onClick: () => {
          setSelectedItem({ kind: 'goal', data: activeGoal });
          fitView({ nodes: [{ id: activeGoal.id }], duration: 220, maxZoom: 1.2 });
        },
      });
    }

    if (activeTask) {
      crumbs.push({
        id: activeTask.id,
        label: activeTask.title,
        isLeaf: true,
        onClick: () => {
          setSelectedItem({ kind: 'task', data: activeTask });
        },
      });
    }

    return crumbs;
  }, [activeVision, activeGoal, activeTask, fitView]);

  const handleBack = useCallback(() => {
    if (activeTask && activeGoal) {
      setSelectedItem({ kind: 'goal', data: activeGoal });
      fitView({ nodes: [{ id: activeGoal.id }], duration: 220, maxZoom: 1.2 });
    } else if (activeGoal && activeVision) {
      setSelectedItem({ kind: 'vision', data: activeVision });
      fitView({ nodes: [{ id: activeVision.id }], duration: 220, maxZoom: 1.1 });
    } else if (activeVision) {
      setSelectedItem(null);
      fitView({ padding: 0.18, duration: 220 });
    }
  }, [activeTask, activeGoal, activeVision, fitView]);

  if (loading && !substrateData) {
    return (
      <div className="flex flex-col items-center justify-center w-full h-[calc(100vh-112px)] min-h-[680px] bg-[#140D0B] text-[#D8CFC2]">
        <Loader2 className="w-8 h-8 text-[#DF6B3B] animate-spin mb-3" />
        <p className="font-mono text-xs tracking-wider">Loading Visions & Goals Substrate...</p>
      </div>
    );
  }

  if (error && !substrateData) {
    return (
      <div className="flex flex-col items-center justify-center w-full h-[calc(100vh-112px)] min-h-[680px] bg-[#140D0B] text-[#F7F3EC] p-6 text-center">
        <AlertTriangle className="w-10 h-10 text-[#E04819] mb-3" />
        <h2 className="font-display text-lg font-bold mb-1">Failed to Connect Substrate</h2>
        <p className="font-mono text-xs text-[#B9AA9D] max-w-md mb-4">{error}</p>
        <button
          type="button"
          onClick={fetchData}
          className="px-4 py-2 bg-[#DF6B3B] hover:bg-[#C83214] text-[#F7F3EC] font-mono text-xs font-bold rounded-xs transition-colors cursor-pointer"
        >
          Retry Connection
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col w-full h-[calc(100vh-112px)] min-h-[680px] border border-[#3B2A23] bg-[#140D0B] overflow-hidden">
      {/* Dedicated Top Canvas Control Bar: Breadcrumbs on Left, Zoom/Controls on Right */}
      <div className="h-14 shrink-0 px-4 border-b border-[#382821] bg-[#18100D] flex items-center justify-between gap-4 z-20">
        <nav
          aria-label="Visions nesting hierarchy"
          className="flex items-center gap-1.5 min-w-0 max-w-[70%] overflow-x-auto py-1"
        >
          {breadcrumbs.length > 1 && (
            <button
              type="button"
              onClick={handleBack}
              aria-label="Go back one nesting level"
              title="Go back"
              className="p-1.5 rounded-xs border border-[#3F2E27] bg-[#1F1512] text-[#D8CFC2] hover:text-[#F7F3EC] hover:border-[#DF6B3B] transition-colors cursor-pointer mr-0.5 shrink-0"
            >
              <ChevronLeft className="w-3.5 h-3.5" />
            </button>
          )}

          <ol className="flex items-center gap-1.5 font-mono text-xs text-[#B9AA9D] list-none p-0 m-0">
            {breadcrumbs.map((crumb, idx) => {
              const isLast = idx === breadcrumbs.length - 1;
              const Icon = crumb.icon;
              return (
                <li key={crumb.id} className="inline-flex items-center gap-1.5 shrink-0">
                  {idx > 0 && (
                    <ChevronRight className="w-3 h-3 text-[#6E584B] shrink-0" aria-hidden="true" />
                  )}
                  {isLast ? (
                    <span
                      aria-current="location"
                      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-xs bg-[#241814] text-[#F7F3EC] border border-[#594238] font-semibold truncate max-w-[240px]"
                    >
                      {Icon && <Icon className="w-3.5 h-3.5 text-[#DF6B3B] shrink-0" />}
                      <span className="truncate">{crumb.label}</span>
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={crumb.onClick}
                      className="inline-flex items-center gap-1.5 px-2 py-1 rounded-xs hover:bg-[#2C1E19] hover:text-[#F7F3EC] text-[#D8CFC2] transition-colors cursor-pointer truncate max-w-[200px]"
                    >
                      {Icon && <Icon className="w-3.5 h-3.5 text-[#DF6B3B] shrink-0" />}
                      <span className="truncate">{crumb.label}</span>
                    </button>
                  )}
                </li>
              );
            })}
          </ol>

          {breadcrumbs.length > 1 && (
            <button
              type="button"
              onClick={() => setIsBreadcrumbPinned((p) => !p)}
              aria-label={isBreadcrumbPinned ? 'Unpin breadcrumb view' : 'Pin breadcrumb view'}
              title={
                isBreadcrumbPinned
                  ? 'Unpin path (auto-clears on background click)'
                  : 'Pin path (stays focused)'
              }
              aria-pressed={isBreadcrumbPinned}
              className={`p-1.5 rounded-xs border transition-colors cursor-pointer ml-1 shrink-0 ${
                isBreadcrumbPinned
                  ? 'bg-[#DF6B3B] text-[#F7F3EC] border-[#E04819]'
                  : 'border-transparent text-[#8C7263] hover:text-[#F7F3EC] hover:bg-[#2C1E19]'
              }`}
            >
              <Pin className={`w-3.5 h-3.5 ${isBreadcrumbPinned ? 'fill-current' : ''}`} />
            </button>
          )}
        </nav>

        {/* Right: Zoom and Other Controls */}
        <div className="flex items-center gap-1.5 shrink-0">
          <IconButton label="Zoom In" onClick={() => zoomIn({ duration: 150 })}>
            <ZoomIn className="w-4 h-4" />
          </IconButton>
          <IconButton label="Zoom Out" onClick={() => zoomOut({ duration: 150 })}>
            <ZoomOut className="w-4 h-4" />
          </IconButton>
          <IconButton label="Fit Visions & Goals" onClick={() => fitView({ padding: 0.18, duration: 220 })}>
            <Maximize2 className="w-4 h-4" />
          </IconButton>
          <div className="w-px h-6 bg-[#3D2B24] mx-1" />
          <IconButton
            label="Expand All Visions & Goals"
            onClick={() => {
              if (!substrateData) return;
              setExpandedVisionIds(substrateData.visions.map((v) => v.id));
              setExpandedGoalIds(substrateData.goals.map((g) => g.id));
            }}
          >
            <ChevronDown className="w-4 h-4" />
          </IconButton>
          <IconButton
            label="Reset & Collapse All"
            onClick={() => {
              setExpandedVisionIds([]);
              setExpandedGoalIds([]);
              setSelectedItem(null);
              fitView({ padding: 0.18, duration: 220 });
            }}
          >
            <RotateCcw className="w-4 h-4" />
          </IconButton>
        </div>
      </div>

      <div className="relative flex-1 hayate-contour-bg">
        <div className="absolute inset-0 w-full h-full" data-testid="visions-goals-react-flow">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            nodeTypes={nodeTypes}
            nodesDraggable
            zoomOnDoubleClick={false}
            onNodeDoubleClick={handleNodeDoubleClick}
            onNodeDragStart={onNodeDragStart}
            onNodeDrag={onNodeDrag}
            onNodeDragStop={onNodeDragStop}
            onNodeMouseEnter={onNodeMouseEnter}
            onNodeMouseLeave={onNodeMouseLeave}
            onNodeClick={handleNodeClick}
            onPaneClick={() => {
              if (!isBreadcrumbPinned) {
                setSelectedItem(null);
              }
            }}
            fitView
            fitViewOptions={{ padding: 0.18 }}
            minZoom={0.16}
            maxZoom={1.6}
          >
            <Background
              variant={BackgroundVariant.Dots}
              gap={24}
              size={1.2}
              color="#3D2B24"
            />
            <MiniMap
              style={{ width: 136, height: 84 }}
              nodeColor={(n) =>
                n.type === 'visionNode'
                  ? '#2C4A35'
                  : n.type === 'goalNode'
                  ? '#C83214'
                  : '#DF6B3B'
              }
              maskColor="rgba(20, 13, 11, 0.72)"
            />
          </ReactFlow>
        </div>

        {/* Sidebar Detail Panel */}
        {selectedItem && (
          <aside
            aria-label="Vision, Goal or Task details"
            className="absolute top-4 right-4 bottom-4 w-full max-w-sm z-30 bg-[#DFE4D8] text-[#18120F] border border-[#8C7263] shadow-2xl flex flex-col overflow-hidden rounded-sm"
          >
            <div className="px-5 py-4 border-b border-[#C5CBBF] flex items-start justify-between gap-3 bg-[#E5EAE0]">
              <div className="min-w-0">
                <div className="font-mono text-[11px] text-[#6B5A4E] truncate uppercase tracking-wider">
                  {selectedItem.kind === 'vision'
                    ? `Vision · ${selectedItem.data.readableKey}`
                    : selectedItem.kind === 'goal'
                    ? `Goal · ${selectedItem.data.readableKey}`
                    : `Task · ${selectedItem.data.readableKey}`}
                </div>
                <h2 className="font-display text-lg font-bold tracking-tight text-[#18120F] mt-0.5">
                  {selectedItem.data.title}
                </h2>
              </div>
              <IconButton
                label="Close Details"
                tooltipSide="left"
                className="!bg-[#18120F] !text-[#DFE4D8] !border-[#18120F] hover:!bg-[#C83214] hover:!border-[#C83214]"
                onClick={() => setSelectedItem(null)}
              >
                <X className="w-4 h-4" />
              </IconButton>
            </div>

            {selectedItem.kind === 'vision' && (
              <div className="flex-1 overflow-y-auto p-5 space-y-4 text-xs">
                <div className="font-mono text-[11px] text-[#5D5046] border-b border-[#C5CBBF] pb-2 flex items-center justify-between">
                  <span>Status: <strong className="uppercase text-[#2C4A35]">{selectedItem.data.status}</strong></span>
                  <span>{selectedItem.data.goalsCount} Goals</span>
                </div>
                <div>
                  <h3 className="font-mono text-[11px] uppercase tracking-wider text-[#6B5A4E] mb-1.5">
                    Vision Description
                  </h3>
                  <p className="text-sm text-[#2C221D] leading-relaxed">
                    {selectedItem.data.description || 'No description recorded.'}
                  </p>
                </div>
                <div>
                  <h3 className="font-mono text-[11px] uppercase tracking-wider text-[#6B5A4E] mb-1.5">
                    Target Alignment
                  </h3>
                  <div className="bg-[#D2D8CA] border border-[#B6BEAE] p-3 rounded-xs font-mono text-xs text-[#18120F]">
                    <div>Type: <strong className="text-[#2C4A35]">{selectedItem.data.targetType}</strong></div>
                    {selectedItem.data.targetLabel && (
                      <div className="mt-1">Label: {selectedItem.data.targetLabel}</div>
                    )}
                  </div>
                </div>
              </div>
            )}

            {selectedItem.kind === 'goal' && (
              <div className="flex-1 overflow-y-auto p-5 space-y-4 text-xs">
                <div className="font-mono text-[11px] text-[#5D5046] border-b border-[#C5CBBF] pb-2 flex items-center justify-between">
                  <span>Status: <strong className="uppercase text-[#C83214]">{selectedItem.data.status}</strong></span>
                  <span>Progress: {selectedItem.data.progress}%</span>
                </div>
                <div>
                  <h3 className="font-mono text-[11px] uppercase tracking-wider text-[#6B5A4E] mb-1.5">
                    Goal Directive
                  </h3>
                  <p className="text-sm text-[#2C221D] leading-relaxed">
                    {selectedItem.data.title}
                  </p>
                </div>
                <div className="grid grid-cols-2 gap-2 font-mono text-xs bg-[#D2D8CA] border border-[#B6BEAE] p-3 rounded-xs">
                  <div>
                    <span className="text-[#6B5A4E]">Priority:</span> <strong className="text-[#18120F]">{selectedItem.data.priority.toFixed(2)}</strong>
                  </div>
                  <div>
                    <span className="text-[#6B5A4E]">Notoriety:</span> <strong className="text-[#18120F]">{selectedItem.data.blockerNotoriety}</strong>
                  </div>
                </div>
              </div>
            )}

            {selectedItem.kind === 'task' && (
              <div className="flex-1 overflow-y-auto p-5 space-y-4 text-xs">
                <div className="font-mono text-[11px] text-[#5D5046] border-b border-[#C5CBBF] pb-2 flex items-center justify-between">
                  <span>Status: <strong className="uppercase text-[#DF6B3B]">{selectedItem.data.status}</strong></span>
                  <span className={`px-2 py-0.5 border rounded-xs font-mono text-[10px] ${leaseBadgeClass(selectedItem.data.occupancy.leaseState)}`}>
                    {leaseLabel(selectedItem.data.occupancy.leaseState)}
                  </span>
                </div>
                <div>
                  <h3 className="font-mono text-[11px] uppercase tracking-wider text-[#6B5A4E] mb-1.5">
                    Task Specification
                  </h3>
                  <p className="text-sm text-[#2C221D] leading-relaxed">
                    {selectedItem.data.title}
                  </p>
                </div>
                <div>
                  <h3 className="font-mono text-[11px] uppercase tracking-wider text-[#6B5A4E] mb-1.5">
                    Evaluation Script
                  </h3>
                  <pre className="bg-[#18120F] text-[#F2EBE1] p-3 font-mono text-[11px] rounded-xs whitespace-pre-wrap break-all">
                    {selectedItem.data.evalScript || 'No evaluation script recorded.'}
                  </pre>
                </div>
              </div>
            )}
          </aside>
        )}
      </div>
    </div>
  );
}

export function VisionsGoalsGraphView(props: VisionsGoalsGraphViewProps) {
  return (
    <ReactFlowProvider>
      <NodeDetailProvider>
        <VisionsGoalsGraphCanvas {...props} />
      </NodeDetailProvider>
    </ReactFlowProvider>
  );
}
