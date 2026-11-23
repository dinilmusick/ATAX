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
  type Node,
  type NodeProps,
} from '@xyflow/react';
import {
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Flag,
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
  VisionGraphNodeData,
} from '../types/substrate';
import {
  buildVisionsGoalsGraph,
  formatContextUsage,
  GOAL_NODES,
} from '../utils/graphData';
import { useFloatyForceLayout } from '../hooks/useFloatyForceLayout';
import { IconButton } from './IconButton';
import { NodeDetailProvider, useNodeDetail } from '../context/NodeDetailContext';

type VisionNodeData = VisionGraphNodeData & { expanded?: boolean };
type GoalNodeData = GoalGraphNodeData & { expanded?: boolean };

type SelectedGraphItem =
  | { kind: 'vision'; data: VisionGraphNodeData }
  | { kind: 'goal'; data: GoalGraphNodeData }
  | { kind: 'task'; data: TaskGraphNodeData };

function VisionNode({ data, selected }: NodeProps) {
  const vision = data as unknown as VisionNodeData;
  const isContainerExpanded = Boolean(vision.expanded);
  const { isExpanded, isPinned, toggleExpand, togglePin } = useNodeDetail(vision.id);

  if (isContainerExpanded) {
    return (
      <div
        data-node-id={vision.id}
        className={`w-full h-full rounded-sm border-2 transition-colors duration-150 flex flex-col ${
          selected
            ? 'bg-[#19120F]/95 border-[#C83214] ring-1 ring-[#C83214]'
            : 'bg-[#16100D]/95 border-[#C5CBBF]/80 hover:border-[#DFE4D8]'
        }`}
      >
        <Handle
          type="target"
          position={Position.Left}
          className="!w-2.5 !h-2.5 !bg-[#C83214] !border !border-[#18120F] !rounded-none"
        />
        <Handle
          type="source"
          position={Position.Right}
          className="!w-2.5 !h-2.5 !bg-[#C83214] !border !border-[#18120F] !rounded-none"
        />

        {/* Sage-Ivory Header Band on Expanded Container */}
        <div className="bg-[#DFE4D8] text-[#18120F] px-4 py-2.5 border-b border-[#B6BEAE] flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <Target className="w-4 h-4 text-[#C83214] shrink-0" />
            <h3 className="font-display text-sm font-bold text-[#18120F] truncate">
              {vision.title}
            </h3>
          </div>
          <div className="inline-flex items-center gap-1 font-mono text-[10px] font-semibold text-[#18120F] shrink-0">
            <ChevronDown className="w-3 h-3 text-[#C83214]" />
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
      className={`w-full h-full rounded-sm border transition-colors duration-150 relative ${
        isExpanded
          ? 'bg-[#EAEFE3] text-[#18120F] border-[#C83214] ring-1 ring-[#C83214] z-40'
          : selected
          ? 'bg-[#EAEFE3] text-[#18120F] border-[#C83214] ring-1 ring-[#C83214]'
          : 'bg-[#DFE4D8] text-[#18120F] border-[#968A7B] hover:border-[#C83214]'
      }`}
    >
      <Handle
        type="target"
        position={Position.Left}
        className="!w-2.5 !h-2.5 !bg-[#C83214] !border !border-[#18120F] !rounded-none"
      />

      {/* Clean Default Vision Body: Icon, Title, and Expand Button Only */}
      <div className="flex items-center justify-between gap-2.5 px-3.5 h-full">
        <div className="flex items-center gap-2.5 min-w-0">
          <Target className="w-4 h-4 text-[#C83214] shrink-0" />
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
          className="nodrag nopan p-1 rounded-xs text-[#5D5046] hover:text-[#18120F] hover:bg-[#C5CBBF] transition-colors shrink-0 cursor-pointer"
        >
          <ChevronDown className="w-3.5 h-3.5 pointer-events-none" />
        </button>
      </div>

      {/* Expanded Overlay: Reveals All Details with Pin and Collapse Actions */}
      {isExpanded && (
        <div className="nodrag nopan absolute top-0 left-0 w-full z-50 rounded-sm border border-[#C83214] bg-[#DFE4D8] text-[#18120F] shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-100">
          <div className="flex items-center justify-between gap-2 px-3.5 py-2.5 bg-[#D2D8CA] border-b border-[#B6BEAE]">
            <div className="flex items-center gap-2 min-w-0">
              <Target className="w-4 h-4 text-[#C83214] shrink-0 pointer-events-none" />
              <span className="font-display text-sm font-bold truncate text-[#18120F]">
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
                    ? 'bg-[#C83214] text-[#F7F3EC] border border-[#E04819]'
                    : 'text-[#5D5046] hover:text-[#18120F] hover:bg-[#B6BEAE] border border-transparent'
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
                className="nodrag nopan p-1 rounded-xs text-[#5D5046] hover:text-[#18120F] hover:bg-[#B6BEAE] transition-colors cursor-pointer"
              >
                <ChevronUp className="w-3.5 h-3.5 pointer-events-none" />
              </button>
            </div>
          </div>

          <div className="p-3.5 space-y-2 text-xs">
            <div className="flex items-center justify-between gap-2 text-[11px] font-mono text-[#5D5046]">
              <span>VISION · {vision.readableKey}</span>
              <span className="uppercase font-semibold text-[#C83214]">
                {vision.status.replace('_', ' ')}
              </span>
            </div>

            <p className="text-xs text-[#3F352E] leading-relaxed">
              {vision.description}
            </p>

            <div className="pt-2 border-t border-[#C4CABD] flex items-center justify-between text-[11px] font-mono text-[#52463E]">
              <span className="truncate">
                {vision.targetType}: {vision.targetLabel}
              </span>
              <span className="inline-flex items-center gap-1 font-semibold text-[#18120F] shrink-0">
                <ChevronRight className="w-3 h-3 text-[#C83214]" />
                {vision.goalsCount} goals
              </span>
            </div>
          </div>
        </div>
      )}

      <Handle
        type="source"
        position={Position.Right}
        className="!w-2.5 !h-2.5 !bg-[#C83214] !border !border-[#18120F] !rounded-none"
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
        className={`w-full h-full rounded-sm border transition-colors duration-150 flex flex-col ${
          selected
            ? 'bg-[#170F0C]/95 text-[#F7F3EC] border-[#E04819] ring-1 ring-[#E04819]'
            : 'bg-[#130C0A]/95 text-[#F2EBE1] border-[#C83214]/80 hover:border-[#E04819]'
        }`}
      >
        <Handle
          type="target"
          position={Position.Left}
          className="!w-2.5 !h-2.5 !bg-[#C83214] !border !border-[#140D0B] !rounded-none"
        />
        <Handle
          type="source"
          position={Position.Right}
          className="!w-2.5 !h-2.5 !bg-[#C83214] !border !border-[#140D0B] !rounded-none"
        />

        <div className="bg-[#251915] border-b border-[#3E2C25] px-3.5 py-2 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <Flag className="w-3.5 h-3.5 text-[#DF6B3B] shrink-0" />
            <h3 className="font-display text-sm font-semibold text-[#F7F3EC] truncate">
              {goal.title}
            </h3>
          </div>
          <div className="inline-flex items-center gap-1 text-[11px] font-mono text-[#DFE4D8] shrink-0">
            <ChevronDown className="w-3.5 h-3.5 text-[#E04819]" />
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
      className={`w-full h-full rounded-sm border transition-colors duration-150 relative ${
        isExpanded
          ? 'bg-[#281A16] text-[#F7F3EC] border-[#E04819] ring-1 ring-[#E04819] z-40'
          : selected
          ? 'bg-[#2F201B] text-[#F7F3EC] border-[#E04819] ring-1 ring-[#E04819]'
          : 'bg-[#251915] text-[#F2EBE1] border-[#594238] hover:border-[#C83214]'
      }`}
    >
      <Handle
        type="target"
        position={Position.Left}
        className="!w-2.5 !h-2.5 !bg-[#C83214] !border !border-[#140D0B] !rounded-none"
      />

      {/* Clean Default Goal Body: Icon, Title, and Expand Button Only */}
      <div className="flex items-center justify-between gap-2.5 px-3 h-full">
        <div className="flex items-center gap-2 min-w-0">
          <Flag className="w-3.5 h-3.5 text-[#DF6B3B] shrink-0" />
          <span className="font-display text-xs font-semibold leading-tight text-[#F7F3EC] truncate">
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
          className="nodrag nopan p-1 rounded-xs text-[#B9AA9D] hover:text-[#F7F3EC] hover:bg-[#382821] transition-colors shrink-0 cursor-pointer"
        >
          <ChevronDown className="w-3.5 h-3.5 pointer-events-none" />
        </button>
      </div>

      {/* Expanded Overlay: Reveals All Details with Pin and Collapse Actions */}
      {isExpanded && (
        <div className="nodrag nopan absolute top-0 left-0 w-full z-50 rounded-sm border border-[#C83214] bg-[#251915] text-[#F7F3EC] shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-100">
          <div className="flex items-center justify-between gap-2 px-3.5 py-2.5 bg-[#2E1E19] border-b border-[#433027]">
            <div className="flex items-center gap-2 min-w-0">
              <Flag className="w-3.5 h-3.5 text-[#DF6B3B] shrink-0 pointer-events-none" />
              <span className="font-display text-sm font-semibold truncate text-[#F7F3EC]">
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
                    ? 'bg-[#C83214] text-[#F7F3EC] border border-[#E04819]'
                    : 'text-[#B9AA9D] hover:text-[#F7F3EC] hover:bg-[#382821] border border-transparent'
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
                className="nodrag nopan p-1 rounded-xs text-[#B9AA9D] hover:text-[#F7F3EC] hover:bg-[#382821] transition-colors cursor-pointer"
              >
                <ChevronUp className="w-3.5 h-3.5 pointer-events-none" />
              </button>
            </div>
          </div>

          <div className="p-3.5 space-y-2 text-xs">
            <div className="flex items-center justify-between gap-2 text-[11px] font-mono">
              <span className="text-[#D8CFC2]">GOAL · {goal.readableKey}</span>
              <span
                className={`uppercase font-medium ${
                  goal.status === 'verified' ? 'text-[#6CC48E]' : 'text-[#E04819]'
                }`}
              >
                {goal.status}
              </span>
            </div>

            <div className="space-y-1">
              <div className="flex items-center justify-between text-[11px] font-mono text-[#B9AA9D]">
                <span>
                  Loop {goal.currentIteration}/{goal.maxIterations}
                </span>
                <span>{goal.progress}%</span>
              </div>
              <div className="w-full h-1.5 bg-[#140D0B] overflow-hidden">
                <div
                  className={`h-full ${
                    goal.status === 'verified' ? 'bg-[#6CC48E]' : 'bg-[#C83214]'
                  }`}
                  style={{ width: `${goal.progress}%` }}
                />
              </div>
            </div>

            <div className="pt-2 border-t border-[#3E2C25] flex items-center justify-between text-[11px] font-mono text-[#A89688]">
              <span>
                Priority {goal.priority.toFixed(2)} · Notoriety {goal.blockerNotoriety}
              </span>
              <span className="inline-flex items-center gap-1 text-[#DFE4D8]">
                <ChevronRight className="w-3 h-3 text-[#E04819]" />
                {goal.tasksCount} tasks
              </span>
            </div>
          </div>
        </div>
      )}

      <Handle
        type="source"
        position={Position.Right}
        className="!w-2.5 !h-2.5 !bg-[#C83214] !border !border-[#140D0B] !rounded-none"
      />
    </div>
  );
}

function TaskNode({ data, selected }: NodeProps) {
  const task = data as unknown as TaskGraphNodeData;
  const ctx = formatContextUsage(task.contextLimit);
  const { isExpanded, isPinned, toggleExpand, togglePin } = useNodeDetail(task.id);

  return (
    <div
      data-node-id={task.id}
      data-expanded-node={isExpanded}
      className={`w-full h-full rounded-sm border transition-colors duration-150 relative ${
        isExpanded
          ? 'bg-[#221612] text-[#F7F3EC] border-[#E04819] ring-1 ring-[#E04819] z-40'
          : selected
          ? 'bg-[#261A16] text-[#F7F3EC] border-[#E04819] ring-1 ring-[#E04819]'
          : 'bg-[#1A110E] text-[#F2EBE1] border-[#4A362D] hover:border-[#C83214]'
      }`}
    >
      <Handle
        type="target"
        position={Position.Left}
        className="!w-2.5 !h-2.5 !bg-[#DF6B3B] !border !border-[#140D0B] !rounded-none"
      />

      {/* Clean Default Task Body: Icon, Title, and Expand Button Only */}
      <div className="flex items-center justify-between gap-2.5 px-3 h-full">
        <div className="flex items-center gap-2 min-w-0">
          <Terminal className="w-3.5 h-3.5 text-[#DF6B3B] shrink-0" />
          <span className="font-display text-xs font-semibold leading-tight text-[#F7F3EC] truncate">
            {task.title}
          </span>
        </div>
        <button
          type="button"
          aria-label={`Expand details for ${task.title}`}
          onClick={(e) => {
            e.stopPropagation();
            toggleExpand();
          }}
          className="nodrag nopan p-1 rounded-xs text-[#B9AA9D] hover:text-[#F7F3EC] hover:bg-[#382821] transition-colors shrink-0 cursor-pointer"
        >
          <ChevronDown className="w-3.5 h-3.5 pointer-events-none" />
        </button>
      </div>

      {/* Expanded Overlay: Reveals All Details with Pin and Collapse Actions */}
      {isExpanded && (
        <div className="nodrag nopan absolute top-0 left-0 w-full z-50 rounded-sm border border-[#DF6B3B] bg-[#1A110E] text-[#F7F3EC] shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-100">
          <div className="flex items-center justify-between gap-2 px-3.5 py-2.5 bg-[#251814] border-b border-[#3D2921]">
            <div className="flex items-center gap-2 min-w-0">
              <Terminal className="w-3.5 h-3.5 text-[#DF6B3B] shrink-0 pointer-events-none" />
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
                    ? 'bg-[#C83214] text-[#F7F3EC] border border-[#E04819]'
                    : 'text-[#B9AA9D] hover:text-[#F7F3EC] hover:bg-[#382821] border border-transparent'
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
                className="nodrag nopan p-1 rounded-xs text-[#B9AA9D] hover:text-[#F7F3EC] hover:bg-[#382821] transition-colors cursor-pointer"
              >
                <ChevronUp className="w-3.5 h-3.5 pointer-events-none" />
              </button>
            </div>
          </div>

          <div className="p-3.5 space-y-2.5 text-xs max-h-[340px] overflow-y-auto">
            <div className="flex items-center justify-between gap-2 text-[11px] font-mono">
              <span className="text-[#DF6B3B] font-semibold">
                TASK · {task.readableKey}
              </span>
              <span className="text-[#B9AA9D] uppercase">{task.status}</span>
            </div>

            {/* Eval Script */}
            <div className="space-y-1">
              <div className="text-[10px] font-mono uppercase tracking-wider text-[#9C8A7C]">
                Eval Script
              </div>
              <pre className="bg-[#110B09] border border-[#352620] px-2.5 py-1.5 text-[10px] font-mono text-[#E8DFD3] whitespace-pre-wrap break-all leading-relaxed">
                {task.evalScript}
              </pre>
            </div>

            {/* Inputs & Outputs */}
            <div className="grid grid-cols-2 gap-2 text-[10px] font-mono bg-[#150E0B] border border-[#352620] p-2">
              <div className="min-w-0">
                <div className="uppercase tracking-wider text-[#9C8A7C] mb-1">Inputs</div>
                <ul className="space-y-0.5 text-[#D8CFC2]">
                  {task.inputs.map((inp) => (
                    <li key={inp} className="truncate">
                      {inp}
                    </li>
                  ))}
                </ul>
              </div>
              <div className="min-w-0 border-l border-[#352620] pl-2">
                <div className="uppercase tracking-wider text-[#9C8A7C] mb-1">Outputs</div>
                <ul className="space-y-0.5 text-[#DFE4D8]">
                  {task.outputs.map((out) => (
                    <li key={out} className="truncate">
                      {out}
                    </li>
                  ))}
                </ul>
              </div>
            </div>

            {/* Tools Available */}
            <div className="space-y-1">
              <div className="text-[10px] font-mono uppercase tracking-wider text-[#9C8A7C]">
                Tools Available
              </div>
              <div className="flex flex-wrap items-center gap-1.5 font-mono text-[10px] text-[#E6DDD1]">
                {task.toolsAvailable.map((tool, idx) => (
                  <React.Fragment key={tool}>
                    <span className="bg-[#291D19] border border-[#433129] px-1.5 py-0.5 rounded-xs">
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
            </div>

            {/* Context Limit */}
            <div className="pt-2 border-t border-[#352620] space-y-1">
              <div className="flex items-center justify-between text-[10px] font-mono">
                <span className="uppercase tracking-wider text-[#9C8A7C]">Context Limit</span>
                <span className="text-[#E6DDD1]">
                  {ctx.usedLabel} / {ctx.maxLabel} ({ctx.percent}%)
                </span>
              </div>
              <div className="w-full h-1.5 bg-[#110B09] overflow-hidden">
                <div
                  className={`h-full ${
                    ctx.percent >= 75 ? 'bg-[#E04819]' : 'bg-[#C83214]'
                  }`}
                  style={{ width: `${ctx.percent}%` }}
                />
              </div>
            </div>
          </div>
        </div>
      )}

      <Handle
        type="source"
        position={Position.Right}
        className="!w-2.5 !h-2.5 !bg-[#DF6B3B] !border !border-[#140D0B] !rounded-none"
      />
    </div>
  );
}

const nodeTypes = {
  visionNode: VisionNode,
  goalNode: GoalNode,
  taskNode: TaskNode,
};

function VisionsGoalsCanvas() {
  const [expandedVisionIds, setExpandedVisionIds] = useState<string[]>([]);
  const [expandedGoalIds, setExpandedGoalIds] = useState<string[]>([]);
  const [selectedItem, setSelectedItem] = useState<SelectedGraphItem | null>(null);
  const { zoomIn, zoomOut, fitView } = useReactFlow();

  const initialGraph = useMemo(
    () => buildVisionsGoalsGraph({ expandedVisionIds, expandedGoalIds }),
    [expandedVisionIds, expandedGoalIds]
  );
  const [nodes, setNodes, onNodesChange] = useNodesState(initialGraph.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialGraph.edges);

  const {
    onNodeDragStart,
    onNodeDrag,
    onNodeDragStop,
    onNodeMouseEnter,
    onNodeMouseLeave,
    applySavedAnchors,
    resetBodies,
  } = useFloatyForceLayout({
    baseNodes: initialGraph.nodes,
    edges,
    setNodes,
    enabled: true,
    amplitude: 4.5,
  });

  useEffect(() => {
    const anchoredNodes = applySavedAnchors(initialGraph.nodes);
    setNodes(anchoredNodes);
    setEdges(initialGraph.edges);
    resetBodies(anchoredNodes, false);
    const timer = window.setTimeout(() => fitView({ padding: 0.16, duration: 200 }), 140);
    return () => window.clearTimeout(timer);
  }, [initialGraph, setNodes, setEdges, applySavedAnchors, resetBodies, fitView]);

  const handleReset = useCallback(() => {
    setExpandedVisionIds([]);
    setExpandedGoalIds([]);
    setSelectedItem(null);
    const fresh = buildVisionsGoalsGraph({ expandedVisionIds: [], expandedGoalIds: [] });
    setNodes(fresh.nodes);
    setEdges(fresh.edges);
    resetBodies(fresh.nodes, true);
    setTimeout(() => fitView({ padding: 0.24, duration: 220 }), 120);
  }, [setNodes, setEdges, resetBodies, fitView]);

  const clickTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (clickTimerRef.current !== null) window.clearTimeout(clickTimerRef.current);
    };
  }, []);

  const handleNodeClick = useCallback((_: React.MouseEvent, node: Node) => {
    if (clickTimerRef.current !== null) window.clearTimeout(clickTimerRef.current);
    clickTimerRef.current = window.setTimeout(() => {
      clickTimerRef.current = null;
      if (node.type === 'visionNode') {
        setSelectedItem({
          kind: 'vision',
          data: node.data as unknown as VisionGraphNodeData,
        });
      } else if (node.type === 'goalNode') {
        setSelectedItem({
          kind: 'goal',
          data: node.data as unknown as GoalGraphNodeData,
        });
      } else if (node.type === 'taskNode') {
        setSelectedItem({
          kind: 'task',
          data: node.data as unknown as TaskGraphNodeData,
        });
      }
    }, 210);
  }, []);

  const handleNodeDoubleClick = useCallback((_: React.MouseEvent, node: Node) => {
    if (clickTimerRef.current !== null) {
      window.clearTimeout(clickTimerRef.current);
      clickTimerRef.current = null;
    }
    if (node.type === 'visionNode') {
      const visionId = node.id;
      setExpandedVisionIds((prev) => {
        const isCurrentlyExpanded = prev.includes(visionId);
        if (isCurrentlyExpanded) {
          const childGoalIds = new Set(
            GOAL_NODES.filter((g) => g.visionId === visionId).map((g) => g.id)
          );
          setExpandedGoalIds((gPrev) => gPrev.filter((gid) => !childGoalIds.has(gid)));
          return prev.filter((id) => id !== visionId);
        }
        return [...prev, visionId];
      });
    } else if (node.type === 'goalNode') {
      const goalId = node.id;
      setExpandedGoalIds((prev) =>
        prev.includes(goalId) ? prev.filter((id) => id !== goalId) : [...prev, goalId]
      );
    }
  }, []);

  const visibleVisions = nodes.filter((n) => n.type === 'visionNode').length;
  const visibleGoals = nodes.filter((n) => n.type === 'goalNode').length;
  const visibleTasks = nodes.filter((n) => n.type === 'taskNode').length;

  return (
    <div className="flex flex-col w-full h-[calc(100vh-112px)] min-h-[700px] border border-[#3B2A23] bg-[#140D0B] overflow-hidden">
      {/* Dedicated Top Icon-Only Control Bar (Filter Buttons Removed per Request) */}
      <div className="h-14 shrink-0 px-4 border-b border-[#382821] bg-[#18100D] flex items-center justify-between gap-4 z-20">
        <div className="flex items-center gap-1.5">
          <IconButton label="Zoom In" onClick={() => zoomIn({ duration: 150 })}>
            <ZoomIn className="w-4 h-4" />
          </IconButton>
          <IconButton label="Zoom Out" onClick={() => zoomOut({ duration: 150 })}>
            <ZoomOut className="w-4 h-4" />
          </IconButton>
          <IconButton
            label="Fit Vision-Goal-Task Flow"
            onClick={() => fitView({ padding: 0.2, duration: 220 })}
          >
            <Maximize2 className="w-4 h-4" />
          </IconButton>
          <IconButton label="Reset & Collapse Flow" onClick={handleReset}>
            <RotateCcw className="w-4 h-4" />
          </IconButton>
        </div>

        <div className="text-[11px] font-mono text-[#B9AA9D] flex items-center gap-3">
          <span className="text-[#DFE4D8]">Visions: {visibleVisions}</span>
          <span aria-hidden="true">·</span>
          <span className="text-[#E04819]">Goals: {visibleGoals}</span>
          <span aria-hidden="true">·</span>
          <span>Tasks: {visibleTasks}</span>
          <span aria-hidden="true">·</span>
          <span className="text-[#DF6B3B]">Dbl-click to nest · Edges: data flow</span>
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
            onPaneClick={() => setSelectedItem(null)}
            fitView
            fitViewOptions={{ padding: 0.24 }}
            minZoom={0.28}
            maxZoom={1.6}
          >
            <Background
              variant={BackgroundVariant.Lines}
              gap={36}
              lineWidth={0.6}
              color="#261B17"
            />
            <MiniMap
              style={{ width: 132, height: 82 }}
              nodeColor={(n) =>
                n.type === 'visionNode'
                  ? '#DFE4D8'
                  : n.type === 'goalNode'
                  ? '#C83214'
                  : '#6D5447'
              }
              maskColor="rgba(20, 13, 11, 0.72)"
            />
          </ReactFlow>
        </div>

        {/* Node Inspector Drawer */}
        {selectedItem && (
          <aside
            aria-label="Node contract inspector"
            className="absolute top-4 right-4 bottom-4 w-full max-w-md z-30 bg-[#DFE4D8] text-[#18120F] border border-[#8C7263] shadow-2xl flex flex-col overflow-hidden rounded-sm"
          >
            <div className="px-5 py-4 border-b border-[#C5CBBF] flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="font-mono text-[11px] uppercase tracking-wider text-[#C83214] font-semibold">
                  {selectedItem.kind} · {selectedItem.data.readableKey}
                </div>
                <h2 className="font-display text-lg font-bold tracking-tight text-[#18120F] mt-0.5">
                  {selectedItem.data.title}
                </h2>
              </div>
              <IconButton
                label="Close Node Inspector"
                tooltipSide="left"
                className="!bg-[#18120F] !text-[#DFE4D8] !border-[#18120F] hover:!bg-[#C83214] hover:!border-[#C83214]"
                onClick={() => setSelectedItem(null)}
              >
                <X className="w-4 h-4" />
              </IconButton>
            </div>

            <div className="flex-1 overflow-y-auto p-5 space-y-5 text-xs">
              {selectedItem.kind === 'vision' && (
                <>
                  <p className="text-sm text-[#2C221D] leading-relaxed">
                    {selectedItem.data.description}
                  </p>
                  <div className="border-t border-[#C5CBBF] pt-3 space-y-2 font-mono">
                    <div className="flex justify-between">
                      <span className="text-[#6B5A4E]">Target Type</span>
                      <span>{selectedItem.data.targetType}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-[#6B5A4E]">Target Label</span>
                      <span>{selectedItem.data.targetLabel}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-[#6B5A4E]">Status</span>
                      <span className="uppercase font-semibold text-[#C83214]">
                        {selectedItem.data.status}
                      </span>
                    </div>
                  </div>
                </>
              )}

              {selectedItem.kind === 'goal' && (
                <div className="space-y-3 font-mono">
                  <div className="flex justify-between border-b border-[#C5CBBF] pb-2">
                    <span className="text-[#6B5A4E]">Goal Type</span>
                    <span>{selectedItem.data.goalType}</span>
                  </div>
                  <div className="flex justify-between border-b border-[#C5CBBF] pb-2">
                    <span className="text-[#6B5A4E]">Loop Iteration</span>
                    <span>
                      {selectedItem.data.currentIteration} / {selectedItem.data.maxIterations}
                    </span>
                  </div>
                  <div className="flex justify-between border-b border-[#C5CBBF] pb-2">
                    <span className="text-[#6B5A4E]">Priority</span>
                    <span>{selectedItem.data.priority}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-[#6B5A4E]">Blocker Notoriety</span>
                    <span className="font-semibold text-[#C83214]">
                      {selectedItem.data.blockerNotoriety}
                    </span>
                  </div>
                </div>
              )}

              {selectedItem.kind === 'task' && (
                <div className="space-y-4">
                  <div>
                    <h3 className="font-mono text-[11px] uppercase tracking-wider text-[#6B5A4E] mb-1.5">
                      Eval Script
                    </h3>
                    <pre className="bg-[#18120F] text-[#F2EBE1] p-3 font-mono text-[11px] overflow-x-auto rounded-xs whitespace-pre-wrap break-all">
                      {selectedItem.data.evalScript}
                    </pre>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div className="bg-[#D2D8CA] border border-[#B6BEAE] p-3 rounded-xs">
                      <h4 className="font-mono text-[10px] uppercase tracking-wider text-[#5D5046] mb-1.5">
                        Inputs
                      </h4>
                      <ul className="space-y-1 font-mono text-[11px] text-[#18120F]">
                        {selectedItem.data.inputs.map((i) => (
                          <li key={i}>{i}</li>
                        ))}
                      </ul>
                    </div>
                    <div className="bg-[#D2D8CA] border border-[#B6BEAE] p-3 rounded-xs">
                      <h4 className="font-mono text-[10px] uppercase tracking-wider text-[#5D5046] mb-1.5">
                        Outputs
                      </h4>
                      <ul className="space-y-1 font-mono text-[11px] text-[#18120F]">
                        {selectedItem.data.outputs.map((o) => (
                          <li key={o}>{o}</li>
                        ))}
                      </ul>
                    </div>
                  </div>

                  <div>
                    <h3 className="font-mono text-[11px] uppercase tracking-wider text-[#6B5A4E] mb-1.5">
                      Tools Available
                    </h3>
                    <div className="flex flex-wrap gap-1.5 font-mono text-[11px]">
                      {selectedItem.data.toolsAvailable.map((t) => (
                        <span
                          key={t}
                          className="bg-[#18120F] text-[#DFE4D8] px-2.5 py-1 rounded-xs"
                        >
                          {t}
                        </span>
                      ))}
                    </div>
                  </div>

                  <div className="border-t border-[#C5CBBF] pt-3 space-y-1.5 font-mono">
                    <div className="flex justify-between text-[11px]">
                      <span className="text-[#5D5046]">Context Limit</span>
                      <span className="font-semibold">
                        {selectedItem.data.contextLimit.usedTokens.toLocaleString()} /{' '}
                        {selectedItem.data.contextLimit.maxTokens.toLocaleString()} tokens
                      </span>
                    </div>
                    <div className="w-full h-2 bg-[#C4CABD] overflow-hidden">
                      <div
                        className="h-full bg-[#C83214]"
                        style={{
                          width: `${formatContextUsage(selectedItem.data.contextLimit).percent}%`,
                        }}
                      />
                    </div>
                  </div>
                </div>
              )}
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}

export function VisionsGoalsGraphView() {
  return (
    <ReactFlowProvider>
      <NodeDetailProvider>
        <VisionsGoalsCanvas />
      </NodeDetailProvider>
    </ReactFlowProvider>
  );
}
