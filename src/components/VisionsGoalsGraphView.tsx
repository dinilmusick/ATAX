import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Background,
  BackgroundVariant,
  ConnectionMode,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import {
  AlertTriangle,
  ArrowRight,
  CalendarClock,
  ChevronLeft,
  ChevronRight,
  Compass,
  Flag,
  GitBranch,
  GitMerge,
  Info,
  Loader2,
  Maximize2,
  Palette,
  RotateCcw,
  Split,
  Target,
  Terminal,
  Trash2,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import type {
  BranchingNodeItem,
  BranchingNodeKind,
  CustomDomainNodeItem,
  CustomEdgeItem,
  GoalGraphNodeData,
  GroupingBoxItem,
  NodeColorPreferences,
  NodeDeadlineOverride,
  NodeTypeKey,
  SavedNodePositionsMap,
  StickyNoteItem,
  TaskGraphNodeData,
  TaskOccupancyInfo,
  VisionGraphNodeData,
  VisionsGoalsSubstrateResponse,
} from '../types/substrate';
import {
  buildVisionsGoalsGraph,
  formatContextUsage,
  GOAL_NODE_SIZE,
  normalizeVisionsHierarchy,
  TASK_NODE_SIZE,
  VISION_NODE_SIZE,
  type VisionsGoalsScope,
} from '../utils/graphData';
import {
  computeDeadlineHighlight,
  getContrastTextPalette,
} from '../utils/deadlineHighlight';
import {
  appendUniqueCustomEdge,
  createBranchingNode,
  createCustomDomainNode,
  createCustomEdge,
  createGroupingBox,
  createStickyNote,
  DEFAULT_NODE_BODY_COLORS,
  defaultPortLabelsForBranching,
  loadBranchingNodes,
  loadCustomDomainNodes,
  loadCustomEdges,
  loadDeadlineOverrides,
  loadGroupingBoxes,
  loadNodeColorPreferences,
  loadSavedNodePositions,
  loadStickyNotes,
  NODE_COLOR_PRESETS,
  pullVisualStateFromServer,
  resolveNodeBodyColor,
  saveBranchingNodes,
  saveCustomDomainNodes,
  saveCustomEdges,
  saveDeadlineOverrides,
  saveGroupingBoxes,
  saveNodeColorPreferences,
  saveSavedNodePositions,
  saveStickyNotes,
} from '../utils/graphAnnotations';
import { useGraphInteraction } from '../hooks/useGraphInteraction';
import { IconButton } from './IconButton';
import {
  GroupBoxNode,
  StickyNoteNode,
  type GroupBoxNodeData,
  type StickyNoteNodeData,
} from './GraphAnnotationNodes';
import {
  BRANCHING_NODE_SIZE,
  FanOutNode,
  MultiInSingleOutNode,
  SingleInMultiOutNode,
} from './BranchingLogicNodes';
import { GraphAppearancePopover } from './GraphAppearancePopover';
import { GraphContextMenu, type ContextMenuState } from './GraphContextMenu';

interface VisionsGoalsGraphViewProps {
  refreshTick?: number;
  onLoadingChange?: (loading: boolean) => void;
}

type SelectedGraphItem =
  | { kind: 'vision'; data: VisionGraphNodeData; isCustom?: boolean }
  | { kind: 'goal'; data: GoalGraphNodeData; isCustom?: boolean }
  | { kind: 'task'; data: TaskGraphNodeData; isCustom?: boolean }
  | { kind: 'branching'; data: BranchingNodeItem }
  | { kind: 'edge'; data: CustomEdgeItem };

type EnrichedVisionNodeData = VisionGraphNodeData & {
  customBodyColor?: string;
  deadlineOverride?: NodeDeadlineOverride;
};

type EnrichedGoalNodeData = GoalGraphNodeData & {
  customBodyColor?: string;
  deadlineOverride?: NodeDeadlineOverride;
};

type EnrichedTaskNodeData = TaskGraphNodeData & {
  customBodyColor?: string;
  deadlineOverride?: NodeDeadlineOverride;
};

function leaseBadgeClass(state: TaskOccupancyInfo['leaseState']): string {
  switch (state) {
    case 'lease_valid':
      return 'text-[#6EE7B7] border-[#22C58B]/60 bg-[#0A231A]';
    case 'lease_expired':
      return 'text-[#FCA5A5] border-[#EF4444]/60 bg-[#2A1010]';
    case 'unknown':
      return 'text-[#FCD34D] border-[#F59E0B]/60 bg-[#261705]';
    default:
      return 'text-[#94A3B8] border-[#334155] bg-[#0F172A]';
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

function toDatetimeLocalValue(iso?: string | null): string {
  if (!iso) return '';
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return '';
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function toCustomFlowEdge(ce: CustomEdgeItem): Edge {
  return {
    id: ce.id,
    type: 'smoothstep',
    source: ce.source,
    target: ce.target,
    sourceHandle: ce.sourceHandle ?? undefined,
    targetHandle: ce.targetHandle ?? undefined,
    label: ce.label || 'flow',
    animated: false,
    zIndex: 30,
    markerEnd: {
      type: MarkerType.ArrowClosed,
      color: '#DF6B3B',
      width: 15,
      height: 15,
    },
    style: {
      stroke: '#DF6B3B',
      strokeWidth: 2,
    },
    labelStyle: {
      fill: '#F7F3EC',
      fontSize: 10,
      fontFamily: 'JetBrains Mono, ui-monospace, monospace',
    },
    labelBgStyle: {
      fill: '#241814',
      fillOpacity: 0.94,
    },
    labelBgPadding: [6, 3] as [number, number],
  };
}

/**
 * VISION NODE — Crowned Observatory Archway / Stepped Citadel Crest (356 x 162)
 * Lightweight crisp SVG rendering (no heavy CSS drop-shadow stacks).
 */
const VisionNode = React.memo(function VisionNode({ data, selected }: NodeProps) {
  const vision = data as unknown as EnrichedVisionNodeData;
  const fill = vision.customBodyColor || DEFAULT_NODE_BODY_COLORS.vision;
  const palette = getContrastTextPalette(fill);
  const highlight = computeDeadlineHighlight({
    startAt: vision.deadlineOverride?.startAt || vision.createdAt,
    deadlineAt: vision.deadlineOverride?.deadlineAt || vision.deadlineAt,
    status: vision.status,
    defaultStroke: '#34D399',
  });
  const stroke = selected ? highlight.selectedStrokeColor : highlight.strokeColor;

  return (
    <div
      data-node-id={vision.id}
      data-node-shape="vision-arch"
      data-deadline-level={highlight.level}
      className="group relative w-full h-full cursor-grab active:cursor-grabbing select-none"
    >
      <svg
        viewBox="0 0 356 162"
        className="absolute inset-0 w-full h-full pointer-events-none overflow-visible"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        {selected && (
          <path
            d="M 18 160 L 4 146 L 4 64 C 4 22 76 6 178 4 C 280 6 352 22 352 64 L 352 146 L 338 160 Z"
            fill="none"
            stroke={stroke}
            strokeOpacity={0.32}
            strokeWidth={7}
          />
        )}
        <path
          d="M 18 160 L 4 146 L 4 64 C 4 22 76 6 178 4 C 280 6 352 22 352 64 L 352 146 L 338 160 Z"
          fill={fill}
          stroke={stroke}
          strokeWidth={selected ? 2.75 : 2}
          strokeLinejoin="miter"
        />
        <path
          d="M 22 153 L 11 142 L 11 66 C 11 30 78 13 178 11 C 278 13 345 30 345 66 L 345 142 L 334 153 Z"
          fill="none"
          stroke={stroke}
          strokeOpacity={0.25}
          strokeWidth={1}
        />
        <polygon points="178,0 185,7 178,14 171,7" fill={stroke} />
      </svg>

      <Handle
        id="in"
        type="target"
        position={Position.Left}
        style={{ backgroundColor: stroke, borderColor: fill }}
        className="!w-3.5 !h-3.5 !border-2 !rounded-full"
      />

      <div className="relative z-10 w-full h-full flex flex-col justify-between px-6 pt-5 pb-3.5">
        <div
          className="flex items-center justify-between gap-2 text-[10px] font-mono"
          style={{ color: palette.mutedColor }}
        >
          <span className="inline-flex items-center gap-1.5 font-semibold tracking-wider uppercase truncate">
            <Compass className="w-3.5 h-3.5 shrink-0" style={{ color: stroke }} />
            <span>Vision · {vision.readableKey}</span>
          </span>
          <span
            className="inline-flex items-center gap-1.5 font-semibold shrink-0"
            style={{ color: highlight.level === 'none' ? palette.mutedColor : stroke }}
          >
            <span
              aria-hidden="true"
              className="w-2 h-2 rounded-full shrink-0"
              style={{ backgroundColor: highlight.strokeColor }}
            />
            <span>{highlight.remainingLabel}</span>
          </span>
        </div>

        <div className="my-auto py-1">
          <h3
            className="font-display text-sm font-bold leading-snug line-clamp-2"
            style={{ color: palette.titleColor }}
          >
            {vision.title}
          </h3>
          {vision.description && (
            <p className="text-[11px] truncate mt-0.5" style={{ color: palette.mutedColor }}>
              {vision.description}
            </p>
          )}
        </div>

        <div
          className="pt-1.5 flex items-center justify-between gap-2 text-[11px] font-mono"
          style={{ borderTop: `1px solid ${palette.dividerColor}`, color: palette.bodyColor }}
        >
          <span className="truncate uppercase text-[10px]" style={{ color: palette.mutedColor }}>
            {vision.targetLabel ? `${vision.targetType}: ${vision.targetLabel}` : vision.targetType}
          </span>
          <span
            className="inline-flex items-center gap-1 font-semibold shrink-0 tabular-nums"
            style={{ color: palette.titleColor }}
          >
            <span>{vision.goalsCount} goals</span>
            <ArrowRight className="w-3 h-3 opacity-80 group-hover:translate-x-0.5 transition-transform" />
          </span>
        </div>
      </div>

      <Handle
        id="out"
        type="source"
        position={Position.Right}
        style={{ backgroundColor: stroke, borderColor: fill }}
        className="!w-3.5 !h-3.5 !border-2 !rounded-full"
      />
    </div>
  );
});

/**
 * GOAL NODE — Faceted Pointed Hexagon (304 x 118)
 */
const GoalNode = React.memo(function GoalNode({ data, selected }: NodeProps) {
  const goal = data as unknown as EnrichedGoalNodeData;
  const fill = goal.customBodyColor || DEFAULT_NODE_BODY_COLORS.goal;
  const palette = getContrastTextPalette(fill);
  const highlight = computeDeadlineHighlight({
    startAt: goal.deadlineOverride?.startAt || goal.createdAt,
    deadlineAt: goal.deadlineOverride?.deadlineAt || goal.deadlineAt,
    status: goal.status,
    defaultStroke: '#F59E0B',
  });
  const stroke = selected ? highlight.selectedStrokeColor : highlight.strokeColor;
  const isDone = goal.status === 'verified' || goal.status === 'completed';

  return (
    <div
      data-node-id={goal.id}
      data-node-shape="goal-hexagon"
      data-deadline-level={highlight.level}
      className="group relative w-full h-full cursor-grab active:cursor-grabbing select-none"
    >
      <svg
        viewBox="0 0 304 118"
        className="absolute inset-0 w-full h-full pointer-events-none overflow-visible"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        {selected && (
          <polygon
            points="24,2 280,2 302,59 280,116 24,116 2,59"
            fill="none"
            stroke={stroke}
            strokeOpacity={0.32}
            strokeWidth={7}
          />
        )}
        <polygon
          points="24,2 280,2 302,59 280,116 24,116 2,59"
          fill={fill}
          stroke={stroke}
          strokeWidth={selected ? 2.75 : 2}
          strokeLinejoin="miter"
        />
        <polygon
          points="27,7 277,7 296,59 277,111 27,111 8,59"
          fill="none"
          stroke={stroke}
          strokeOpacity={0.24}
          strokeWidth={1}
        />
      </svg>

      <Handle
        id="in"
        type="target"
        position={Position.Left}
        style={{ backgroundColor: stroke, borderColor: fill }}
        className="!w-3.5 !h-3.5 !border-2 !rounded-full"
      />

      <div className="relative z-10 w-full h-full flex flex-col justify-between px-8 py-3">
        <div
          className="flex items-center justify-between gap-2 text-[10px] font-mono"
          style={{ color: palette.mutedColor }}
        >
          <span className="inline-flex items-center gap-1.5 font-semibold tracking-wider uppercase truncate">
            <Flag className="w-3.5 h-3.5 shrink-0" style={{ color: stroke }} />
            <span>Goal · {goal.readableKey}</span>
          </span>
          <span
            className="inline-flex items-center gap-1 font-semibold shrink-0"
            style={{ color: highlight.level === 'none' ? palette.mutedColor : stroke }}
          >
            <span
              aria-hidden="true"
              className="w-2 h-2 rounded-full shrink-0"
              style={{ backgroundColor: highlight.strokeColor }}
            />
            <span>{highlight.remainingLabel}</span>
          </span>
        </div>

        <h3
          className="font-display text-sm font-bold leading-snug line-clamp-2 my-auto"
          style={{ color: palette.titleColor }}
        >
          {goal.title}
        </h3>

        <div className="space-y-1">
          <div
            className="w-full h-1.5 rounded-full overflow-hidden"
            style={{ backgroundColor: palette.trackBg, border: `1px solid ${palette.dividerColor}` }}
          >
            <div
              className="h-full"
              style={{
                width: `${goal.progress}%`,
                backgroundColor: isDone ? '#22C55E' : stroke,
              }}
            />
          </div>
          <div
            className="flex items-center justify-between text-[10px] font-mono tabular-nums"
            style={{ color: palette.mutedColor }}
          >
            <span>
              {goal.maxIterations > 0
                ? `Loop ${goal.currentIteration}/${goal.maxIterations} · ${goal.progress}%`
                : `Iter ${goal.currentIteration} · ${goal.progress}%`}
            </span>
            <span
              className="inline-flex items-center gap-1 font-semibold"
              style={{ color: palette.titleColor }}
            >
              <span>{goal.tasksCount} tasks</span>
              <ArrowRight className="w-3 h-3 opacity-75 group-hover:translate-x-0.5 transition-transform" />
            </span>
          </div>
        </div>
      </div>

      <Handle
        id="out"
        type="source"
        position={Position.Right}
        style={{ backgroundColor: stroke, borderColor: fill }}
        className="!w-3.5 !h-3.5 !border-2 !rounded-full"
      />
    </div>
  );
});

/**
 * TASK NODE — Dog-Ear Notched Engineering Ticket (276 x 98)
 */
const TaskNode = React.memo(function TaskNode({ data, selected }: NodeProps) {
  const task = data as unknown as EnrichedTaskNodeData;
  const fill = task.customBodyColor || DEFAULT_NODE_BODY_COLORS.task;
  const palette = getContrastTextPalette(fill);
  const highlight = computeDeadlineHighlight({
    startAt: task.deadlineOverride?.startAt || task.startedAt,
    deadlineAt: task.deadlineOverride?.deadlineAt || task.dueAt,
    status: task.status,
    defaultStroke: '#38BDF8',
  });
  const stroke = selected ? highlight.selectedStrokeColor : highlight.strokeColor;
  const ctx = task.contextLimit ? formatContextUsage(task.contextLimit) : null;

  return (
    <div
      data-node-id={task.id}
      data-node-shape="task-notched-ticket"
      data-deadline-level={highlight.level}
      className="group relative w-full h-full cursor-grab active:cursor-grabbing select-none"
    >
      <svg
        viewBox="0 0 276 98"
        className="absolute inset-0 w-full h-full pointer-events-none overflow-visible"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        {selected && (
          <polygon
            points="2,2 254,2 274,22 274,96 2,96"
            fill="none"
            stroke={stroke}
            strokeOpacity={0.32}
            strokeWidth={6}
          />
        )}
        <polygon
          points="2,2 254,2 274,22 274,96 2,96"
          fill={fill}
          stroke={stroke}
          strokeWidth={selected ? 2.5 : 1.75}
          strokeLinejoin="miter"
        />
        <polygon
          points="254,2 254,22 274,22"
          fill={palette.isLight ? 'rgba(0,0,0,0.12)' : 'rgba(255,255,255,0.12)'}
          stroke={stroke}
          strokeWidth={1.25}
          strokeLinejoin="miter"
        />
      </svg>

      <Handle
        id="in"
        type="target"
        position={Position.Left}
        style={{ backgroundColor: stroke, borderColor: fill }}
        className="!w-3 !h-3 !border-2 !rounded-none"
      />

      <div className="relative z-10 w-full h-full flex flex-col justify-between px-4 py-2.5 pr-7">
        <div
          className="flex items-center justify-between gap-2 text-[10px] font-mono min-w-0"
          style={{ color: palette.mutedColor }}
        >
          <span className="inline-flex items-center gap-1.5 font-semibold tracking-wider uppercase truncate min-w-0">
            <Terminal className="w-3.5 h-3.5 shrink-0" style={{ color: stroke }} />
            <span className="truncate">Task · {task.readableKey}</span>
          </span>
          <span
            className="inline-flex items-center gap-1 font-semibold shrink-0"
            style={{ color: highlight.level === 'none' ? palette.mutedColor : stroke }}
          >
            <span
              aria-hidden="true"
              className="w-1.5 h-1.5 rounded-full shrink-0"
              style={{ backgroundColor: highlight.strokeColor }}
            />
            <span>{highlight.remainingLabel}</span>
          </span>
        </div>

        <h3
          className="font-display text-xs font-semibold leading-snug line-clamp-2 my-auto"
          style={{ color: palette.titleColor }}
        >
          {task.title}
        </h3>

        <div
          className="pt-1 flex items-center justify-between gap-2 text-[10px] font-mono tabular-nums"
          style={{ borderTop: `1px solid ${palette.dividerColor}`, color: palette.mutedColor }}
        >
          <span className="truncate">{leaseLabel(task.occupancy.leaseState)}</span>
          {ctx ? (
            <span className="font-semibold shrink-0" style={{ color: palette.titleColor }}>
              {ctx.percent}% ctx
            </span>
          ) : (
            <span className="truncate shrink-0">{task.taskType}</span>
          )}
        </div>
      </div>

      <Handle
        id="out"
        type="source"
        position={Position.Right}
        style={{ backgroundColor: stroke, borderColor: fill }}
        className="!w-3 !h-3 !border-2 !rounded-none"
      />
    </div>
  );
});

const nodeTypes = {
  visionNode: VisionNode,
  goalNode: GoalNode,
  taskNode: TaskNode,
  multiInSingleOutNode: MultiInSingleOutNode,
  singleInMultiOutNode: SingleInMultiOutNode,
  fanOutNode: FanOutNode,
  stickyNoteNode: StickyNoteNode,
  groupBoxNode: GroupBoxNode,
};

function getScopeKey(scope: VisionsGoalsScope): string {
  switch (scope.level) {
    case 'vision':
      return `visions:vision:${scope.visionId}`;
    case 'goal':
      return `visions:goal:${scope.goalId}`;
    case 'task':
      return `visions:task:${scope.taskId}`;
    default:
      return 'visions:root';
  }
}

function branchingNodeTypeFromKind(kind: BranchingNodeKind): string {
  switch (kind) {
    case 'multi_in_single_out':
      return 'multiInSingleOutNode';
    case 'single_in_multi_out':
      return 'singleInMultiOutNode';
    case 'fan_out':
      return 'fanOutNode';
  }
}

function VisionsGoalsGraphCanvas({ refreshTick = 0, onLoadingChange }: VisionsGoalsGraphViewProps) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [rawSubstrate, setRawSubstrate] = useState<VisionsGoalsSubstrateResponse | null>(null);

  const [navScope, setNavScope] = useState<VisionsGoalsScope>({ level: 'root' });
  const [selectedItem, setSelectedItem] = useState<SelectedGraphItem | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState>(null);

  const [colorPrefs, setColorPrefs] = useState<NodeColorPreferences>(() => loadNodeColorPreferences());
  const [stickyNotes, setStickyNotes] = useState<StickyNoteItem[]>(() => loadStickyNotes());
  const [groupBoxes, setGroupBoxes] = useState<GroupingBoxItem[]>(() => loadGroupingBoxes());
  const [branchingNodes, setBranchingNodes] = useState<BranchingNodeItem[]>(() =>
    loadBranchingNodes()
  );
  const [customDomainNodes, setCustomDomainNodes] = useState<CustomDomainNodeItem[]>(() =>
    loadCustomDomainNodes()
  );
  const [customEdges, setCustomEdges] = useState<CustomEdgeItem[]>(() => loadCustomEdges());
  const [savedPositions, setSavedPositions] = useState<SavedNodePositionsMap>(() =>
    loadSavedNodePositions()
  );
  const [deadlineOverrides, setDeadlineOverrides] = useState<Record<string, NodeDeadlineOverride>>(
    () => loadDeadlineOverrides()
  );
  const [appearanceOpen, setAppearanceOpen] = useState(false);

  const { zoomIn, zoomOut, fitView, screenToFlowPosition } = useReactFlow();
  const canvasWrapperRef = useRef<HTMLDivElement | null>(null);

  const scopeKey = useMemo(() => getScopeKey(navScope), [navScope]);

  const fetchData = useCallback(async () => {
    setLoading(true);
    onLoadingChange?.(true);
    setError(null);
    try {
      await pullVisualStateFromServer();
      setStickyNotes(loadStickyNotes());
      setGroupBoxes(loadGroupingBoxes());
      setBranchingNodes(loadBranchingNodes());
      setCustomDomainNodes(loadCustomDomainNodes());
      setCustomEdges(loadCustomEdges());
      setSavedPositions(loadSavedNodePositions());
      setColorPrefs(loadNodeColorPreferences());
      setDeadlineOverrides(loadDeadlineOverrides());

      const res = await fetch('/api/substrate/visions-goals');
      if (!res.ok) {
        throw new Error(`Failed to load Visions substrate (${res.status} ${res.statusText})`);
      }
      const json: VisionsGoalsSubstrateResponse = await res.json();
      setRawSubstrate(json);
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

  const customDomainIds = useMemo(
    () => new Set(customDomainNodes.map((n) => n.id)),
    [customDomainNodes]
  );

  // Merge custom user-created Visions/Goals/Tasks cleanly into substrateData
  const substrateData = useMemo(() => {
    if (!rawSubstrate) return null;

    const customVisions: VisionGraphNodeData[] = customDomainNodes
      .filter((n) => n.domainKind === 'vision')
      .map((n) => ({
        id: n.id,
        readableKey: n.readableKey,
        title: n.title,
        description: n.description,
        targetType: 'custom',
        targetLabel: n.subtitle || 'flow',
        status: n.status || 'active',
        goalsCount: customDomainNodes.filter((g) => g.domainKind === 'goal' && g.parentId === n.id)
          .length,
        createdAt: null,
        deadlineAt: null,
        position: { x: n.x, y: n.y },
      }));

    const customGoals: GoalGraphNodeData[] = customDomainNodes
      .filter((n) => n.domainKind === 'goal')
      .map((n) => ({
        id: n.id,
        readableKey: n.readableKey,
        visionId: n.parentId || null,
        title: n.title,
        description: n.description,
        goalType: n.subtitle || 'flow',
        priority: 0.75,
        status: n.status || 'active',
        blockerNotoriety: 0,
        progress: 0,
        maxIterations: 0,
        currentIteration: 0,
        tasksCount: customDomainNodes.filter((t) => t.domainKind === 'task' && t.parentId === n.id)
          .length,
        createdAt: null,
        deadlineAt: null,
        position: { x: n.x, y: n.y },
      }));

    const customTasks: TaskGraphNodeData[] = customDomainNodes
      .filter((n) => n.domainKind === 'task')
      .map((n) => ({
        id: n.id,
        readableKey: n.readableKey,
        goalId: n.parentId || null,
        parentTaskId: null,
        title: n.title,
        description: n.description,
        taskType: n.subtitle || 'flow',
        status: n.status || 'queued',
        verificationStatus: 'not_started',
        evalScript: '',
        inputs: [],
        outputs: [],
        toolsAvailable: [],
        contextLimit: null,
        checkpoints: [],
        occupancy: {
          agentDisplayLabel: null,
          claimedAt: null,
          heartbeatAt: null,
          claimExpiresAt: null,
          leaseState: 'no_claim',
          currentStep: null,
          blocker: null,
        },
        blockerNotoriety: 0,
        position: { x: n.x, y: n.y },
      }));

    const mergedVisions = [...rawSubstrate.visions, ...customVisions];
    const mergedGoals = [...rawSubstrate.goals, ...customGoals];
    const mergedTasks = [...rawSubstrate.tasks, ...customTasks];
    const normalized = normalizeVisionsHierarchy(mergedVisions, mergedGoals);

    return {
      ...rawSubstrate,
      visions: normalized.visions,
      goals: normalized.goals,
      tasks: mergedTasks,
    };
  }, [rawSubstrate, customDomainNodes]);

  // Base layout computed ONLY from rawSubstrate + navScope so adding custom nodes never shifts existing ones
  const baseSubstrateGraph = useMemo(() => {
    if (!rawSubstrate) return { nodes: [], edges: [] };
    const normalized = normalizeVisionsHierarchy(rawSubstrate.visions, rawSubstrate.goals);
    return buildVisionsGoalsGraph({
      visions: normalized.visions,
      goals: normalized.goals,
      tasks: rawSubstrate.tasks,
      edges: rawSubstrate.edges,
      scope: navScope,
    });
  }, [rawSubstrate, navScope]);

  // Sticky note & grouping box mutation callbacks
  const handleUpdateNoteText = useCallback((id: string, text: string) => {
    setStickyNotes((prev) => {
      const next = prev.map((n) => (n.id === id ? { ...n, text } : n));
      saveStickyNotes(next);
      return next;
    });
  }, []);

  const handleUpdateNoteColor = useCallback((id: string, color: string) => {
    setStickyNotes((prev) => {
      const next = prev.map((n) => (n.id === id ? { ...n, color } : n));
      saveStickyNotes(next);
      return next;
    });
  }, []);

  const handleDeleteNote = useCallback((id: string) => {
    setStickyNotes((prev) => {
      const next = prev.filter((n) => n.id !== id);
      saveStickyNotes(next);
      return next;
    });
  }, []);

  const handleResizeNote = useCallback(
    (id: string, width: number, height: number, x: number, y: number) => {
      setStickyNotes((prev) => {
        const next = prev.map((n) =>
          n.id === id
            ? {
                ...n,
                width: Math.round(width),
                height: Math.round(height),
                x: Math.round(x),
                y: Math.round(y),
              }
            : n
        );
        saveStickyNotes(next);
        return next;
      });
    },
    []
  );

  const handleUpdateGroupTitle = useCallback((id: string, title: string) => {
    setGroupBoxes((prev) => {
      const next = prev.map((g) => (g.id === id ? { ...g, title } : g));
      saveGroupingBoxes(next);
      return next;
    });
  }, []);

  const handleUpdateGroupColor = useCallback((id: string, color: string) => {
    setGroupBoxes((prev) => {
      const next = prev.map((g) => (g.id === id ? { ...g, color } : g));
      saveGroupingBoxes(next);
      return next;
    });
  }, []);

  const handleDeleteGroup = useCallback((id: string) => {
    setGroupBoxes((prev) => {
      const next = prev.filter((g) => g.id !== id);
      saveGroupingBoxes(next);
      return next;
    });
  }, []);

  const handleResizeGroup = useCallback(
    (id: string, width: number, height: number, x: number, y: number) => {
      setGroupBoxes((prev) => {
        const next = prev.map((g) =>
          g.id === id
            ? {
                ...g,
                width: Math.round(width),
                height: Math.round(height),
                x: Math.round(x),
                y: Math.round(y),
              }
            : g
        );
        saveGroupingBoxes(next);
        return next;
      });
    },
    []
  );

  const decorateNodeData = useCallback(
    (nodeType: NodeTypeKey, nodeId: string, baseData: Record<string, unknown>) => ({
      ...baseData,
      customBodyColor: resolveNodeBodyColor(colorPrefs, nodeType, nodeId),
      deadlineOverride: deadlineOverrides[nodeId],
    }),
    [colorPrefs, deadlineOverrides]
  );

  // Build full scoped nodes (group boxes + substrate + custom domain + branching + sticky notes)
  const buildAllScopedNodes = useCallback(
    (targetScopeKey: string): Node[] => {
      const scopedSavedPos = savedPositions[targetScopeKey] || {};

      const scopedGroups: Node[] = groupBoxes
        .filter((g) => g.scopeKey === targetScopeKey)
        .map((g) => ({
          id: g.id,
          type: 'groupBoxNode',
          position: { x: g.x, y: g.y },
          width: g.width,
          height: g.height,
          zIndex: -10,
          style: { width: g.width, height: g.height, zIndex: -10 },
          data: {
            id: g.id,
            title: g.title,
            color: g.color,
            disableFloat: true,
            onUpdateTitle: handleUpdateGroupTitle,
            onUpdateColor: handleUpdateGroupColor,
            onDelete: handleDeleteGroup,
            onResizeFinish: handleResizeGroup,
          } satisfies GroupBoxNodeData,
        }));

      const substrateNodes: Node[] = baseSubstrateGraph.nodes.map((node) => {
        const nodeType: NodeTypeKey =
          node.type === 'visionNode' ? 'vision' : node.type === 'goalNode' ? 'goal' : 'task';
        const saved = scopedSavedPos[node.id];
        return {
          ...node,
          position: saved ? { x: saved.x, y: saved.y } : node.position,
          data: decorateNodeData(nodeType, node.id, node.data as Record<string, unknown>),
        };
      });

      const scopedCustomDomain: Node[] = customDomainNodes
        .filter((cn) => cn.scopeKey === targetScopeKey)
        .map((cn) => {
          const saved = scopedSavedPos[cn.id];
          const pos = saved ? { x: saved.x, y: saved.y } : { x: cn.x, y: cn.y };
          if (cn.domainKind === 'vision') {
            const vData: VisionGraphNodeData = {
              id: cn.id,
              readableKey: cn.readableKey,
              title: cn.title,
              description: cn.description,
              targetType: 'custom',
              targetLabel: cn.subtitle || 'flow',
              status: cn.status,
              goalsCount: customDomainNodes.filter(
                (g) => g.domainKind === 'goal' && g.parentId === cn.id
              ).length,
              position: pos,
            };
            return {
              id: cn.id,
              type: 'visionNode',
              position: pos,
              width: VISION_NODE_SIZE.width,
              height: VISION_NODE_SIZE.height,
              style: { width: VISION_NODE_SIZE.width, height: VISION_NODE_SIZE.height },
              data: decorateNodeData('vision', cn.id, vData as unknown as Record<string, unknown>),
            };
          }
          if (cn.domainKind === 'goal') {
            const gData: GoalGraphNodeData = {
              id: cn.id,
              readableKey: cn.readableKey,
              visionId: cn.parentId || null,
              title: cn.title,
              description: cn.description,
              goalType: cn.subtitle || 'flow',
              priority: 0.75,
              status: cn.status,
              blockerNotoriety: 0,
              progress: 0,
              maxIterations: 0,
              currentIteration: 0,
              tasksCount: customDomainNodes.filter(
                (t) => t.domainKind === 'task' && t.parentId === cn.id
              ).length,
              position: pos,
            };
            return {
              id: cn.id,
              type: 'goalNode',
              position: pos,
              width: GOAL_NODE_SIZE.width,
              height: GOAL_NODE_SIZE.height,
              style: { width: GOAL_NODE_SIZE.width, height: GOAL_NODE_SIZE.height },
              data: decorateNodeData('goal', cn.id, gData as unknown as Record<string, unknown>),
            };
          }
          const tData: TaskGraphNodeData = {
            id: cn.id,
            readableKey: cn.readableKey,
            goalId: cn.parentId || null,
            title: cn.title,
            description: cn.description,
            taskType: cn.subtitle || 'flow',
            status: cn.status,
            verificationStatus: 'not_started',
            evalScript: '',
            inputs: [],
            outputs: [],
            toolsAvailable: [],
            contextLimit: null,
            checkpoints: [],
            occupancy: {
              agentDisplayLabel: null,
              claimedAt: null,
              heartbeatAt: null,
              claimExpiresAt: null,
              leaseState: 'no_claim',
              currentStep: null,
              blocker: null,
            },
            blockerNotoriety: 0,
            position: pos,
          };
          return {
            id: cn.id,
            type: 'taskNode',
            position: pos,
            width: TASK_NODE_SIZE.width,
            height: TASK_NODE_SIZE.height,
            style: { width: TASK_NODE_SIZE.width, height: TASK_NODE_SIZE.height },
            data: decorateNodeData('task', cn.id, tData as unknown as Record<string, unknown>),
          };
        });

      const scopedBranching: Node[] = branchingNodes
        .filter((bn) => bn.scopeKey === targetScopeKey)
        .map((bn) => {
          const saved = scopedSavedPos[bn.id];
          const pos = saved ? { x: saved.x, y: saved.y } : { x: bn.x, y: bn.y };
          return {
            id: bn.id,
            type: branchingNodeTypeFromKind(bn.kind),
            position: pos,
            width: BRANCHING_NODE_SIZE.width,
            height: BRANCHING_NODE_SIZE.height,
            style: { width: BRANCHING_NODE_SIZE.width, height: BRANCHING_NODE_SIZE.height },
            data: decorateNodeData(bn.kind, bn.id, bn as unknown as Record<string, unknown>),
          };
        });

      const scopedNotes: Node[] = stickyNotes
        .filter((n) => n.scopeKey === targetScopeKey)
        .map((n) => ({
          id: n.id,
          type: 'stickyNoteNode',
          position: { x: n.x, y: n.y },
          width: n.width,
          height: n.height,
          zIndex: 15,
          style: { width: n.width, height: n.height, zIndex: 15 },
          data: {
            id: n.id,
            text: n.text,
            color: n.color,
            disableFloat: true,
            onUpdateText: handleUpdateNoteText,
            onUpdateColor: handleUpdateNoteColor,
            onDelete: handleDeleteNote,
            onResizeFinish: handleResizeNote,
          } satisfies StickyNoteNodeData,
        }));

      return [
        ...scopedGroups,
        ...substrateNodes,
        ...scopedCustomDomain,
        ...scopedBranching,
        ...scopedNotes,
      ];
    },
    [
      savedPositions,
      groupBoxes,
      baseSubstrateGraph.nodes,
      customDomainNodes,
      branchingNodes,
      stickyNotes,
      decorateNodeData,
      handleUpdateGroupTitle,
      handleUpdateGroupColor,
      handleDeleteGroup,
      handleResizeGroup,
      handleUpdateNoteText,
      handleUpdateNoteColor,
      handleDeleteNote,
      handleResizeNote,
    ]
  );

  const buildAllScopedEdges = useCallback(
    (targetScopeKey: string): Edge[] => {
      const scopedCustom = customEdges
        .filter((ce) => ce.scopeKey === targetScopeKey)
        .map(toCustomFlowEdge);
      return [...baseSubstrateGraph.edges, ...scopedCustom];
    },
    [baseSubstrateGraph.edges, customEdges]
  );

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);

  const handleAnnotationDragStop = useCallback((node: Node) => {
    if (node.type === 'stickyNoteNode') {
      setStickyNotes((prev) => {
        const next = prev.map((n) =>
          n.id === node.id
            ? { ...n, x: Math.round(node.position.x), y: Math.round(node.position.y) }
            : n
        );
        saveStickyNotes(next);
        return next;
      });
    } else if (node.type === 'groupBoxNode') {
      setGroupBoxes((prev) => {
        const next = prev.map((g) =>
          g.id === node.id
            ? { ...g, x: Math.round(node.position.x), y: Math.round(node.position.y) }
            : g
        );
        saveGroupingBoxes(next);
        return next;
      });
    }
  }, []);

  const handlePositionsCommit = useCallback(
    (updates: Array<{ id: string; x: number; y: number; nodeType?: string }>) => {
      if (updates.length === 0) return;

      setSavedPositions((prev) => {
        const scopeMap = { ...(prev[scopeKey] || {}) };
        for (const u of updates) {
          scopeMap[u.id] = { x: u.x, y: u.y };
        }
        const next = { ...prev, [scopeKey]: scopeMap };
        saveSavedNodePositions(next);
        return next;
      });

      const updateMap = new Map(updates.map((u) => [u.id, u]));
      setCustomDomainNodes((prev) => {
        let changed = false;
        const next = prev.map((n) => {
          const u = updateMap.get(n.id);
          if (!u) return n;
          changed = true;
          return { ...n, x: u.x, y: u.y };
        });
        if (changed) saveCustomDomainNodes(next);
        return changed ? next : prev;
      });

      setBranchingNodes((prev) => {
        let changed = false;
        const next = prev.map((n) => {
          const u = updateMap.get(n.id);
          if (!u) return n;
          changed = true;
          return { ...n, x: u.x, y: u.y };
        });
        if (changed) saveBranchingNodes(next);
        return changed ? next : prev;
      });
    },
    [scopeKey]
  );

  const { onNodeDragStart, onNodeDrag, onNodeDragStop } = useGraphInteraction({
    setNodes,
    onAnnotationDragStop: handleAnnotationDragStop,
    onPositionsCommit: handlePositionsCommit,
  });

  // Fit viewport only when navigating to a new scope or loading fresh substrate
  const prevFittedScopeRef = useRef<string | null>(null);
  useEffect(() => {
    const freshNodes = buildAllScopedNodes(scopeKey);
    const freshEdges = buildAllScopedEdges(scopeKey);
    setNodes(freshNodes);
    setEdges(freshEdges);

    const fitKey = `${scopeKey}:${rawSubstrate ? 'loaded' : 'empty'}`;
    if (rawSubstrate && prevFittedScopeRef.current !== fitKey) {
      prevFittedScopeRef.current = fitKey;
      const timer = window.setTimeout(() => {
        fitView({ padding: 0.2, duration: 180, maxZoom: 1.15 });
      }, 80);
      return () => window.clearTimeout(timer);
    }
    return undefined;
  }, [baseSubstrateGraph, scopeKey, rawSubstrate]); // eslint-disable-line react-hooks/exhaustive-deps

  // Reconcile custom nodes, branching nodes, annotations, colors, deadlines, and custom edges without resetting dragged positions or camera
  useEffect(() => {
    const targetNodes = buildAllScopedNodes(scopeKey);
    const targetMap = new Map(targetNodes.map((n) => [n.id, n]));

    setNodes((prev) => {
      const existingById = new Map(prev.map((n) => [n.id, n]));
      const merged: Node[] = [];
      for (const fresh of targetNodes) {
        const existing = existingById.get(fresh.id);
        merged.push(
          existing
            ? {
                ...fresh,
                position: existing.position,
                selected: existing.selected,
              }
            : fresh
        );
      }
      // Also preserve if any item removed (filter handled by iterating targetNodes)
      void targetMap;
      return merged;
    });

    setEdges(buildAllScopedEdges(scopeKey));
  }, [
    buildAllScopedNodes,
    buildAllScopedEdges,
    scopeKey,
    setNodes,
    setEdges,
  ]);

  // Connect nodes by dragging from any handle to any handle
  const handleConnect = useCallback(
    (connection: Connection) => {
      if (!connection.source || !connection.target || connection.source === connection.target) {
        return;
      }
      const created = createCustomEdge(
        scopeKey,
        connection.source,
        connection.target,
        connection.sourceHandle,
        connection.targetHandle,
        'flow'
      );
      if (!created) return;
      setCustomEdges((prev) => {
        const next = appendUniqueCustomEdge(prev, created);
        saveCustomEdges(next);
        return next;
      });
    },
    [scopeKey]
  );

  const handleDeleteCustomEdge = useCallback((edgeId: string) => {
    setCustomEdges((prev) => {
      const next = prev.filter((e) => e.id !== edgeId);
      saveCustomEdges(next);
      return next;
    });
    setSelectedItem((prev) => (prev?.kind === 'edge' && prev.data.id === edgeId ? null : prev));
  }, []);

  const handleEdgesDelete = useCallback((deleted: Edge[]) => {
    if (deleted.length === 0) return;
    const deletedIds = new Set(deleted.map((e) => e.id));
    setCustomEdges((prev) => {
      const next = prev.filter((e) => !deletedIds.has(e.id));
      saveCustomEdges(next);
      return next;
    });
  }, []);

  // Context Menu Creation Handlers
  const domainAddConfig = useMemo(() => {
    if (navScope.level === 'vision') {
      return {
        label: 'Add Goal',
        kind: 'goal' as const,
        parentId: navScope.visionId,
        width: GOAL_NODE_SIZE.width,
        height: GOAL_NODE_SIZE.height,
      };
    }
    if (navScope.level === 'goal') {
      return {
        label: 'Add Task',
        kind: 'task' as const,
        parentId: navScope.goalId,
        width: TASK_NODE_SIZE.width,
        height: TASK_NODE_SIZE.height,
      };
    }
    if (navScope.level === 'task') {
      return {
        label: 'Add Subtask',
        kind: 'task' as const,
        parentId: navScope.taskId,
        width: TASK_NODE_SIZE.width,
        height: TASK_NODE_SIZE.height,
      };
    }
    return {
      label: 'Add Vision',
      kind: 'vision' as const,
      parentId: null,
      width: VISION_NODE_SIZE.width,
      height: VISION_NODE_SIZE.height,
    };
  }, [navScope]);

  const handleAddDomainNodeAt = useCallback(
    (flowX: number, flowY: number) => {
      const count =
        customDomainNodes.filter(
          (n) => n.scopeKey === scopeKey && n.domainKind === domainAddConfig.kind
        ).length + 1;
      const item = createCustomDomainNode(
        scopeKey,
        domainAddConfig.kind,
        flowX - domainAddConfig.width * 0.5,
        flowY - domainAddConfig.height * 0.5,
        domainAddConfig.parentId,
        count
      );
      setCustomDomainNodes((prev) => {
        const next = [...prev, item];
        saveCustomDomainNodes(next);
        return next;
      });
    },
    [customDomainNodes, domainAddConfig, scopeKey]
  );

  const handleAddBranchingNodeAt = useCallback(
    (kind: BranchingNodeKind, flowX: number, flowY: number) => {
      const item = createBranchingNode(
        scopeKey,
        kind,
        flowX - BRANCHING_NODE_SIZE.width * 0.5,
        flowY - BRANCHING_NODE_SIZE.height * 0.5
      );
      setBranchingNodes((prev) => {
        const next = [...prev, item];
        saveBranchingNodes(next);
        return next;
      });
    },
    [scopeKey]
  );

  const handleAddStickyNoteAt = useCallback(
    (flowX: number, flowY: number) => {
      const note = createStickyNote(scopeKey, flowX - 110, flowY - 82);
      setStickyNotes((prev) => {
        const next = [...prev, note];
        saveStickyNotes(next);
        return next;
      });
    },
    [scopeKey]
  );

  const handleAddGroupingBoxAt = useCallback(
    (flowX: number, flowY: number) => {
      const count = groupBoxes.filter((g) => g.scopeKey === scopeKey).length + 1;
      const box = createGroupingBox(scopeKey, flowX - 240, flowY - 150, `Group ${count}`);
      setGroupBoxes((prev) => {
        const next = [...prev, box];
        saveGroupingBoxes(next);
        return next;
      });
    },
    [groupBoxes, scopeKey]
  );

  const handleDeleteNode = useCallback((nodeId: string) => {
    setStickyNotes((prev) => {
      const next = prev.filter((n) => n.id !== nodeId);
      if (next.length !== prev.length) saveStickyNotes(next);
      return next;
    });
    setGroupBoxes((prev) => {
      const next = prev.filter((g) => g.id !== nodeId);
      if (next.length !== prev.length) saveGroupingBoxes(next);
      return next;
    });
    setBranchingNodes((prev) => {
      const next = prev.filter((b) => b.id !== nodeId);
      if (next.length !== prev.length) saveBranchingNodes(next);
      return next;
    });
    setCustomDomainNodes((prev) => {
      const next = prev.filter((c) => c.id !== nodeId);
      if (next.length !== prev.length) saveCustomDomainNodes(next);
      return next;
    });
    setCustomEdges((prev) => {
      const next = prev.filter((e) => e.source !== nodeId && e.target !== nodeId);
      if (next.length !== prev.length) saveCustomEdges(next);
      return next;
    });
    setSelectedItem((prev) => {
      if (!prev) return null;
      if (prev.kind === 'edge') return prev;
      return prev.data.id === nodeId ? null : prev;
    });
  }, []);

  const handleResetSingleNodePosition = useCallback(
    (nodeId: string) => {
      setSavedPositions((prev) => {
        const scopeMap = { ...(prev[scopeKey] || {}) };
        delete scopeMap[nodeId];
        const next = { ...prev, [scopeKey]: scopeMap };
        saveSavedNodePositions(next);
        return next;
      });
      const baseNode = baseSubstrateGraph.nodes.find((n) => n.id === nodeId);
      if (baseNode) {
        setNodes((prev) =>
          prev.map((n) => (n.id === nodeId ? { ...n, position: { ...baseNode.position } } : n))
        );
      }
    },
    [baseSubstrateGraph.nodes, scopeKey, setNodes]
  );

  const handleChangeTypeColor = useCallback((nodeType: NodeTypeKey, color: string) => {
    setColorPrefs((prev) => {
      const next: NodeColorPreferences = {
        ...prev,
        byType: { ...prev.byType, [nodeType]: color },
      };
      saveNodeColorPreferences(next);
      return next;
    });
  }, []);

  const handleChangeNodeColor = useCallback((nodeId: string, color: string | null) => {
    setColorPrefs((prev) => {
      const nextByNode = { ...prev.byNodeId };
      if (color) {
        nextByNode[nodeId] = color;
      } else {
        delete nextByNode[nodeId];
      }
      const next: NodeColorPreferences = {
        ...prev,
        byNodeId: nextByNode,
      };
      saveNodeColorPreferences(next);
      return next;
    });
  }, []);

  const handleResetAllColors = useCallback(() => {
    const next: NodeColorPreferences = {
      byType: { ...DEFAULT_NODE_BODY_COLORS },
      byNodeId: {},
    };
    setColorPrefs(next);
    saveNodeColorPreferences(next);
  }, []);

  const handleSetDeadlineOverride = useCallback(
    (nodeId: string, override: NodeDeadlineOverride | null) => {
      setDeadlineOverrides((prev) => {
        const next = { ...prev };
        if (override) {
          next[nodeId] = override;
        } else {
          delete next[nodeId];
        }
        saveDeadlineOverrides(next);
        return next;
      });
    },
    []
  );

  const updateCustomDomainField = useCallback(
    (nodeId: string, patch: Partial<CustomDomainNodeItem>) => {
      setCustomDomainNodes((prev) => {
        const next = prev.map((n) => (n.id === nodeId ? { ...n, ...patch } : n));
        saveCustomDomainNodes(next);
        return next;
      });
    },
    []
  );

  const updateBranchingNodeField = useCallback(
    (nodeId: string, patch: Partial<BranchingNodeItem>) => {
      setBranchingNodes((prev) => {
        const next = prev.map((b) => (b.id === nodeId ? { ...b, ...patch } : b));
        saveBranchingNodes(next);
        return next;
      });
    },
    []
  );

  const enterVision = useCallback((visionId: string) => {
    setSelectedItem(null);
    setContextMenu(null);
    setNavScope({ level: 'vision', visionId });
  }, []);

  const enterGoal = useCallback((goalId: string) => {
    setSelectedItem(null);
    setContextMenu(null);
    setNavScope({ level: 'goal', goalId });
  }, []);

  const enterTask = useCallback(
    (taskId: string) => {
      setContextMenu(null);
      if (substrateData) {
        const found = substrateData.tasks.find((t) => t.id === taskId);
        if (found) {
          setSelectedItem({ kind: 'task', data: found, isCustom: customDomainIds.has(found.id) });
        }
      }
      setNavScope({ level: 'task', taskId });
    },
    [substrateData, customDomainIds]
  );

  const selectNodeById = useCallback(
    (nodeId: string, nodeType?: string) => {
      if (nodeType === 'stickyNoteNode' || nodeType === 'groupBoxNode') {
        return;
      }
      const branching = branchingNodes.find((b) => b.id === nodeId);
      if (branching) {
        setSelectedItem({ kind: 'branching', data: branching });
        return;
      }
      if (!substrateData) return;
      const v = substrateData.visions.find((x) => x.id === nodeId);
      if (v) {
        setSelectedItem({ kind: 'vision', data: v, isCustom: customDomainIds.has(v.id) });
        return;
      }
      const g = substrateData.goals.find((x) => x.id === nodeId);
      if (g) {
        setSelectedItem({ kind: 'goal', data: g, isCustom: customDomainIds.has(g.id) });
        return;
      }
      const t = substrateData.tasks.find((x) => x.id === nodeId);
      if (t) {
        setSelectedItem({ kind: 'task', data: t, isCustom: customDomainIds.has(t.id) });
      }
    },
    [branchingNodes, substrateData, customDomainIds]
  );

  const handleNodeClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      setContextMenu(null);
      selectNodeById(node.id, node.type);
    },
    [selectNodeById]
  );

  const handleNodeDoubleClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      if (node.type === 'stickyNoteNode' || node.type === 'groupBoxNode') {
        return;
      }
      if (node.type === 'visionNode') {
        enterVision(node.id);
      } else if (node.type === 'goalNode') {
        enterGoal(node.id);
      } else if (node.type === 'taskNode') {
        enterTask(node.id);
      }
    },
    [enterVision, enterGoal, enterTask]
  );

  const handleEdgeClick = useCallback(
    (_: React.MouseEvent, edge: Edge) => {
      setContextMenu(null);
      const found = customEdges.find((ce) => ce.id === edge.id);
      if (found) {
        setSelectedItem({ kind: 'edge', data: found });
      }
    },
    [customEdges]
  );

  // Keep selected item live in sync with edits
  const activeSelectedItem = useMemo((): SelectedGraphItem | null => {
    if (!selectedItem) return null;
    if (selectedItem.kind === 'branching') {
      const latest = branchingNodes.find((b) => b.id === selectedItem.data.id);
      return latest ? { kind: 'branching', data: latest } : null;
    }
    if (selectedItem.kind === 'edge') {
      const latest = customEdges.find((e) => e.id === selectedItem.data.id);
      return latest ? { kind: 'edge', data: latest } : null;
    }
    if (!substrateData) return selectedItem;
    if (selectedItem.kind === 'vision') {
      const latest = substrateData.visions.find((v) => v.id === selectedItem.data.id);
      return latest ? { kind: 'vision', data: latest, isCustom: selectedItem.isCustom } : null;
    }
    if (selectedItem.kind === 'goal') {
      const latest = substrateData.goals.find((g) => g.id === selectedItem.data.id);
      return latest ? { kind: 'goal', data: latest, isCustom: selectedItem.isCustom } : null;
    }
    const latest = substrateData.tasks.find((t) => t.id === selectedItem.data.id);
    return latest ? { kind: 'task', data: latest, isCustom: selectedItem.isCustom } : null;
  }, [selectedItem, branchingNodes, customEdges, substrateData]);

  // 4-level hierarchy breadcrumbs
  const scopedTask = useMemo(() => {
    if (!substrateData) return null;
    if (navScope.level === 'task') {
      return substrateData.tasks.find((t) => t.id === navScope.taskId) || null;
    }
    if (navScope.level === 'goal' && activeSelectedItem?.kind === 'task') {
      return activeSelectedItem.data;
    }
    return null;
  }, [navScope, activeSelectedItem, substrateData]);

  const scopedGoal = useMemo(() => {
    if (!substrateData) return null;
    if (navScope.level === 'goal') {
      return substrateData.goals.find((g) => g.id === navScope.goalId) || null;
    }
    if (navScope.level === 'task' && scopedTask?.goalId) {
      return substrateData.goals.find((g) => g.id === scopedTask.goalId) || null;
    }
    return null;
  }, [navScope, scopedTask, substrateData]);

  const scopedVision = useMemo(() => {
    if (!substrateData) return null;
    if (navScope.level === 'vision') {
      return substrateData.visions.find((v) => v.id === navScope.visionId) || null;
    }
    if (scopedGoal?.visionId) {
      return substrateData.visions.find((v) => v.id === scopedGoal.visionId) || null;
    }
    return null;
  }, [navScope, scopedGoal, substrateData]);

  const breadcrumbs = useMemo(() => {
    const crumbs: Array<{
      id: string;
      label: string;
      icon?: React.ComponentType<{ className?: string }>;
      onClick?: () => void;
    }> = [
      {
        id: 'root',
        label: 'Visions',
        icon: Target,
        onClick: () => {
          setSelectedItem(null);
          setContextMenu(null);
          setNavScope({ level: 'root' });
        },
      },
    ];

    if (scopedVision) {
      crumbs.push({
        id: scopedVision.id,
        label: scopedVision.title,
        icon: Compass,
        onClick: () => {
          setSelectedItem(null);
          setContextMenu(null);
          setNavScope({ level: 'vision', visionId: scopedVision.id });
        },
      });
    }

    if (scopedGoal) {
      crumbs.push({
        id: scopedGoal.id,
        label: scopedGoal.title,
        icon: Flag,
        onClick: () => {
          setSelectedItem(null);
          setContextMenu(null);
          setNavScope({ level: 'goal', goalId: scopedGoal.id });
        },
      });
    }

    if (scopedTask) {
      crumbs.push({
        id: scopedTask.id,
        label: scopedTask.title,
        icon: Terminal,
      });
    }

    return crumbs;
  }, [scopedVision, scopedGoal, scopedTask]);

  const handleBack = useCallback(() => {
    setSelectedItem(null);
    setContextMenu(null);
    if (navScope.level === 'task') {
      if (scopedGoal) {
        setNavScope({ level: 'goal', goalId: scopedGoal.id });
      } else if (scopedVision) {
        setNavScope({ level: 'vision', visionId: scopedVision.id });
      } else {
        setNavScope({ level: 'root' });
      }
    } else if (navScope.level === 'goal') {
      if (scopedVision) {
        setNavScope({ level: 'vision', visionId: scopedVision.id });
      } else {
        setNavScope({ level: 'root' });
      }
    } else if (navScope.level === 'vision') {
      setNavScope({ level: 'root' });
    }
  }, [navScope.level, scopedGoal, scopedVision]);

  const handleInspectCurrentScope = useCallback(() => {
    if (navScope.level === 'task' && scopedTask) {
      setSelectedItem({
        kind: 'task',
        data: scopedTask,
        isCustom: customDomainIds.has(scopedTask.id),
      });
    } else if (navScope.level === 'goal' && scopedGoal) {
      setSelectedItem({
        kind: 'goal',
        data: scopedGoal,
        isCustom: customDomainIds.has(scopedGoal.id),
      });
    } else if (navScope.level === 'vision' && scopedVision) {
      setSelectedItem({
        kind: 'vision',
        data: scopedVision,
        isCustom: customDomainIds.has(scopedVision.id),
      });
    }
  }, [navScope.level, scopedTask, scopedGoal, scopedVision, customDomainIds]);

  const handleReset = useCallback(() => {
    setSelectedItem(null);
    setContextMenu(null);
    setSavedPositions((prev) => {
      const next = { ...prev };
      delete next[scopeKey];
      saveSavedNodePositions(next);
      return next;
    });
    const freshNodes = buildAllScopedNodes(scopeKey).map((n) => {
      const base = baseSubstrateGraph.nodes.find((bn) => bn.id === n.id);
      return base ? { ...n, position: { ...base.position } } : n;
    });
    setNodes(freshNodes);
    setEdges(buildAllScopedEdges(scopeKey));
    window.setTimeout(() => fitView({ padding: 0.2, duration: 180, maxZoom: 1.15 }), 60);
  }, [
    scopeKey,
    buildAllScopedNodes,
    buildAllScopedEdges,
    baseSubstrateGraph.nodes,
    setNodes,
    setEdges,
    fitView,
  ]);

  if (loading && !substrateData) {
    return (
      <div className="flex flex-col items-center justify-center w-full h-[calc(100vh-112px)] min-h-[680px] bg-[#140D0B] text-[#D8CFC2]">
        <Loader2 className="w-8 h-8 text-[#DF6B3B] animate-spin mb-3" />
        <p className="font-mono text-xs tracking-wider">Loading Visions Substrate...</p>
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

  const renderSidebarAppearanceAndDeadline = (
    nodeId: string,
    nodeType: NodeTypeKey,
    options?: {
      showDeadline?: boolean;
      defaultStart?: string | null;
      defaultDeadline?: string | null;
      status?: string | null;
    }
  ) => {
    const typeDefault = colorPrefs.byType[nodeType] || DEFAULT_NODE_BODY_COLORS[nodeType];
    const currentColor = resolveNodeBodyColor(colorPrefs, nodeType, nodeId);
    const hasCustomNodeColor = Boolean(colorPrefs.byNodeId[nodeId]);
    const showDeadline = options?.showDeadline ?? true;

    const override = deadlineOverrides[nodeId];
    const effectiveStart = override?.startAt || options?.defaultStart || '';
    const effectiveDeadline = override?.deadlineAt || options?.defaultDeadline || '';
    const highlight = computeDeadlineHighlight({
      startAt: effectiveStart || null,
      deadlineAt: effectiveDeadline || null,
      status: options?.status,
      defaultStroke: '#8C7263',
    });

    const applyPresetWindow = (totalHours: number, remainingHours: number) => {
      const now = Date.now();
      const startIso = new Date(now - (totalHours - remainingHours) * 3_600_000).toISOString();
      const deadlineIso = new Date(now + remainingHours * 3_600_000).toISOString();
      handleSetDeadlineOverride(nodeId, { startAt: startIso, deadlineAt: deadlineIso });
    };

    return (
      <div className="pt-3 border-t border-[#C5CBBF] space-y-4">
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <h3 className="font-mono text-[11px] uppercase tracking-wider text-[#6B5A4E]">
              Body Color
            </h3>
            {hasCustomNodeColor && (
              <button
                type="button"
                onClick={() => handleChangeNodeColor(nodeId, null)}
                className="font-mono text-[10px] text-[#C83214] hover:underline cursor-pointer"
              >
                Use Type Default ({typeDefault})
              </button>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {NODE_COLOR_PRESETS.map((preset) => (
              <button
                key={`node-color-${preset.color}`}
                type="button"
                aria-label={`Set selected node color to ${preset.label}`}
                title={preset.label}
                onClick={() => handleChangeNodeColor(nodeId, preset.color)}
                className={`w-5 h-5 rounded-xs border transition-transform cursor-pointer ${
                  currentColor.toLowerCase() === preset.color.toLowerCase()
                    ? 'border-[#18120F] ring-2 ring-[#C83214] scale-110'
                    : 'border-[#8C7263] hover:scale-105'
                }`}
                style={{ backgroundColor: preset.color }}
              />
            ))}
            <label className="inline-flex items-center gap-1.5 ml-auto font-mono text-[10px] text-[#5D5046] cursor-pointer">
              <span>Custom</span>
              <input
                type="color"
                aria-label="Selected node custom body color"
                value={currentColor}
                onChange={(e) => handleChangeNodeColor(nodeId, e.target.value)}
                className="w-6 h-5 border border-[#8C7263] rounded-xs cursor-pointer p-0 bg-transparent"
              />
            </label>
          </div>
        </div>

        {showDeadline && (
          <div className="space-y-2 pt-3 border-t border-[#C5CBBF]">
            <div className="flex items-center justify-between gap-2">
              <h3 className="font-mono text-[11px] uppercase tracking-wider text-[#6B5A4E] inline-flex items-center gap-1.5">
                <CalendarClock className="w-3.5 h-3.5" />
                <span>Deadline Window</span>
              </h3>
              <span className="inline-flex items-center gap-1.5 font-mono text-[11px] font-semibold text-[#18120F]">
                <span
                  aria-hidden="true"
                  className="w-2.5 h-2.5 rounded-full border border-black/20"
                  style={{ backgroundColor: highlight.strokeColor }}
                />
                <span>{highlight.statusText}</span>
              </span>
            </div>

            <div className="grid grid-cols-1 gap-2 font-mono text-[11px]">
              <label className="flex flex-col gap-1">
                <span className="text-[10px] text-[#6B5A4E] uppercase">Start Time</span>
                <input
                  type="datetime-local"
                  aria-label="Node deadline start time"
                  value={toDatetimeLocalValue(effectiveStart)}
                  onChange={(e) => {
                    const val = e.target.value ? new Date(e.target.value).toISOString() : '';
                    handleSetDeadlineOverride(nodeId, {
                      startAt: val,
                      deadlineAt: effectiveDeadline,
                    });
                  }}
                  className="bg-[#EEF1EA] border border-[#9DA594] px-2 py-1 rounded-xs text-[#18120F] text-xs"
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-[10px] text-[#6B5A4E] uppercase">Deadline</span>
                <input
                  type="datetime-local"
                  aria-label="Node deadline target time"
                  value={toDatetimeLocalValue(effectiveDeadline)}
                  onChange={(e) => {
                    const val = e.target.value ? new Date(e.target.value).toISOString() : '';
                    if (!val && !effectiveStart) {
                      handleSetDeadlineOverride(nodeId, null);
                    } else {
                      handleSetDeadlineOverride(nodeId, {
                        startAt: effectiveStart || new Date().toISOString(),
                        deadlineAt: val,
                      });
                    }
                  }}
                  className="bg-[#EEF1EA] border border-[#9DA594] px-2 py-1 rounded-xs text-[#18120F] text-xs"
                />
              </label>
            </div>

            <div className="flex flex-wrap items-center gap-1.5 pt-1 font-mono text-[10px]">
              <button
                type="button"
                onClick={() => applyPresetWindow(100, 80)}
                className="px-2 py-1 rounded-xs border border-[#22C55E] bg-[#DCFCE7] text-[#14532D] font-semibold cursor-pointer"
              >
                Safe (80%)
              </button>
              <button
                type="button"
                onClick={() => applyPresetWindow(100, 40)}
                className="px-2 py-1 rounded-xs border border-[#EAB308] bg-[#FEF9C3] text-[#713F12] font-semibold cursor-pointer"
              >
                Half (40%)
              </button>
              <button
                type="button"
                onClick={() => applyPresetWindow(100, 15)}
                className="px-2 py-1 rounded-xs border border-[#F97316] bg-[#FFEDD5] text-[#7C2D12] font-semibold cursor-pointer"
              >
                Urgent (15%)
              </button>
              <button
                type="button"
                onClick={() => applyPresetWindow(100, 3)}
                className="px-2 py-1 rounded-xs border border-[#EF4444] bg-[#FEE2E2] text-[#7F1D1D] font-semibold cursor-pointer"
              >
                Critical (&le;5%)
              </button>
              {override && (
                <button
                  type="button"
                  onClick={() => handleSetDeadlineOverride(nodeId, null)}
                  className="ml-auto px-2 py-1 rounded-xs border border-[#8C7263] text-[#3B2A23] hover:bg-[#D2D8CA] cursor-pointer"
                >
                  Clear
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    );
  };

  const hasVisibleNodes = nodes.some(
    (n) => n.type !== 'stickyNoteNode' && n.type !== 'groupBoxNode'
  );

  return (
    <div className="flex flex-col w-full h-[calc(100vh-112px)] min-h-[680px] border border-[#3B2A23] bg-[#140D0B] overflow-hidden">
      {/* Top Canvas Bar: 4-Level Nested Breadcrumbs on Left, Appearance & Viewport Controls on Right */}
      <div className="h-14 shrink-0 px-4 border-b border-[#382821] bg-[#18100D] flex items-center justify-between gap-4 z-20">
        <nav
          aria-label="Visions nesting hierarchy"
          className="flex items-center gap-1.5 min-w-0 max-w-[65%] overflow-x-auto py-1"
        >
          {navScope.level !== 'root' && (
            <button
              type="button"
              onClick={handleBack}
              aria-label="Go back one nesting level"
              title="Back"
              className="inline-flex items-center gap-1 px-2 py-1 rounded-xs border border-[#3F2E27] bg-[#1F1512] text-[#D8CFC2] hover:text-[#F7F3EC] hover:border-[#DF6B3B] transition-colors cursor-pointer mr-1 shrink-0 font-mono text-xs"
            >
              <ChevronLeft className="w-3.5 h-3.5" />
              <span>Back</span>
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
                  {isLast || !crumb.onClick ? (
                    <span
                      aria-current="location"
                      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-xs bg-[#241814] text-[#F7F3EC] border border-[#594238] font-semibold truncate max-w-[220px]"
                    >
                      {Icon && <Icon className="w-3.5 h-3.5 text-[#DF6B3B] shrink-0" />}
                      <span className="truncate">{crumb.label}</span>
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={crumb.onClick}
                      className="inline-flex items-center gap-1.5 px-2 py-1 rounded-xs hover:bg-[#2C1E19] hover:text-[#F7F3EC] text-[#D8CFC2] transition-colors cursor-pointer truncate max-w-[180px]"
                    >
                      {Icon && <Icon className="w-3.5 h-3.5 text-[#DF6B3B] shrink-0" />}
                      <span className="truncate">{crumb.label}</span>
                    </button>
                  )}
                </li>
              );
            })}
          </ol>

          {navScope.level !== 'root' && (
            <IconButton
              label={
                navScope.level === 'task'
                  ? 'View current Task details'
                  : navScope.level === 'goal'
                  ? 'View current Goal details'
                  : 'View current Vision details'
              }
              onClick={handleInspectCurrentScope}
              className="ml-1 shrink-0"
            >
              <Info className="w-3.5 h-3.5" />
            </IconButton>
          )}
        </nav>

        {/* Right: Appearance & Viewport Controls (Sticky Notes & Grouping Boxes live in right-click menu) */}
        <div className="flex items-center gap-1.5 shrink-0">
          <span className="hidden xl:inline-block font-mono text-[11px] text-[#8C7263] mr-1.5 whitespace-nowrap">
            Drag: move · Handles: connect · Right-click: add
          </span>
          <IconButton
            label="Node Colors & Deadlines"
            active={appearanceOpen}
            variant="accent"
            onClick={() => setAppearanceOpen((v) => !v)}
          >
            <Palette className="w-4 h-4" />
          </IconButton>
          <div className="w-px h-6 bg-[#3D2B24] mx-1" />
          <IconButton label="Zoom In" onClick={() => zoomIn({ duration: 150 })}>
            <ZoomIn className="w-4 h-4" />
          </IconButton>
          <IconButton label="Zoom Out" onClick={() => zoomOut({ duration: 150 })}>
            <ZoomOut className="w-4 h-4" />
          </IconButton>
          <IconButton
            label="Fit View"
            onClick={() => fitView({ padding: 0.2, duration: 200, maxZoom: 1.15 })}
          >
            <Maximize2 className="w-4 h-4" />
          </IconButton>
          <div className="w-px h-6 bg-[#3D2B24] mx-1" />
          <IconButton label="Reset Node Positions" onClick={handleReset}>
            <RotateCcw className="w-4 h-4" />
          </IconButton>
        </div>
      </div>

      <div ref={canvasWrapperRef} className="relative flex-1 hayate-contour-bg">
        <GraphAppearancePopover
          open={appearanceOpen}
          onClose={() => setAppearanceOpen(false)}
          nodeTypes={[
            { key: 'vision', label: 'Vision (Archway)' },
            { key: 'goal', label: 'Goal (Hexagon)' },
            { key: 'task', label: 'Task (Ticket)' },
            { key: 'multi_in_single_out', label: 'Multi-In Selector' },
            { key: 'single_in_multi_out', label: 'Single-In Router' },
            { key: 'fan_out', label: 'Fan-Out Node' },
          ]}
          colorPrefs={colorPrefs}
          onChangeTypeColor={handleChangeTypeColor}
          onResetColors={handleResetAllColors}
          showDeadlineLegend
        />

        <div className="absolute inset-0 w-full h-full" data-testid="visions-goals-react-flow">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={handleConnect}
            onEdgesDelete={handleEdgesDelete}
            nodeTypes={nodeTypes}
            onlyRenderVisibleElements
            connectionMode={ConnectionMode.Loose}
            nodesDraggable
            nodesConnectable
            edgesFocusable
            deleteKeyCode={['Backspace', 'Delete']}
            connectionLineStyle={{ stroke: '#DF6B3B', strokeWidth: 2 }}
            defaultEdgeOptions={{
              type: 'smoothstep',
              markerEnd: {
                type: MarkerType.ArrowClosed,
                color: '#DF6B3B',
                width: 15,
                height: 15,
              },
            }}
            zoomOnDoubleClick={false}
            onNodeDoubleClick={handleNodeDoubleClick}
            onNodeDragStart={onNodeDragStart}
            onNodeDrag={onNodeDrag}
            onNodeDragStop={onNodeDragStop}
            onNodeClick={handleNodeClick}
            onEdgeClick={handleEdgeClick}
            onPaneClick={() => {
              setSelectedItem(null);
              setAppearanceOpen(false);
              setContextMenu(null);
            }}
            onPaneContextMenu={(event) => {
              event.preventDefault();
              setAppearanceOpen(false);
              const flow = screenToFlowPosition({ x: event.clientX, y: event.clientY });
              setContextMenu({
                kind: 'pane',
                clientX: event.clientX,
                clientY: event.clientY,
                flowX: flow.x,
                flowY: flow.y,
              });
            }}
            onNodeContextMenu={(event, node) => {
              event.preventDefault();
              setAppearanceOpen(false);
              const flow = screenToFlowPosition({ x: event.clientX, y: event.clientY });
              const isDeletable =
                node.type === 'stickyNoteNode' ||
                node.type === 'groupBoxNode' ||
                node.type === 'multiInSingleOutNode' ||
                node.type === 'singleInMultiOutNode' ||
                node.type === 'fanOutNode' ||
                customDomainIds.has(node.id);
              const label =
                String(node.data?.title || node.data?.name || node.data?.readableKey || node.id);
              setContextMenu({
                kind: 'node',
                clientX: event.clientX,
                clientY: event.clientY,
                nodeId: node.id,
                nodeType: node.type || 'node',
                nodeLabel: label,
                isDeletable,
                flowX: flow.x,
                flowY: flow.y,
              });
            }}
            onEdgeContextMenu={(event, edge) => {
              event.preventDefault();
              setAppearanceOpen(false);
              const isCustomEdge = customEdges.some((ce) => ce.id === edge.id);
              setContextMenu({
                kind: 'edge',
                clientX: event.clientX,
                clientY: event.clientY,
                edgeId: edge.id,
                edgeLabel: typeof edge.label === 'string' ? edge.label : undefined,
                isCustomEdge,
              });
            }}
            fitView
            fitViewOptions={{ padding: 0.2 }}
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
              nodeColor={(n) => {
                if (n.type === 'stickyNoteNode') return String(n.data?.color || '#FEF08A');
                if (n.type === 'groupBoxNode') return 'rgba(224, 72, 25, 0.35)';
                if (n.data?.customBodyColor) return String(n.data.customBodyColor);
                if (n.type === 'multiInSingleOutNode') return '#06B6D4';
                if (n.type === 'singleInMultiOutNode') return '#F43F5E';
                if (n.type === 'fanOutNode') return '#84CC16';
                return n.type === 'visionNode'
                  ? '#10B981'
                  : n.type === 'goalNode'
                  ? '#F59E0B'
                  : '#38BDF8';
              }}
              maskColor="rgba(20, 13, 11, 0.72)"
            />
          </ReactFlow>
        </div>

        <GraphContextMenu
          menu={contextMenu}
          domainAddLabel={domainAddConfig.label}
          onClose={() => setContextMenu(null)}
          onAddDomainNode={handleAddDomainNodeAt}
          onAddBranchingNode={handleAddBranchingNodeAt}
          onAddStickyNote={handleAddStickyNoteAt}
          onAddGroupingBox={handleAddGroupingBoxAt}
          onInspectNode={(nodeId) => selectNodeById(nodeId)}
          onDeleteNode={handleDeleteNode}
          onResetNodePosition={handleResetSingleNodePosition}
          onDeleteEdge={handleDeleteCustomEdge}
        />

        {/* Empty Nested Level State */}
        {!loading && !hasVisibleNodes && (
          <div className="absolute inset-0 z-10 flex items-center justify-center pointer-events-none">
            <div className="pointer-events-auto border border-[#433129] bg-[#1D1411] px-6 py-5 rounded-sm text-center space-y-3 max-w-md shadow-2xl">
              <div className="font-display text-base font-semibold text-[#F7F3EC]">
                {navScope.level === 'vision'
                  ? 'No Goals Inside This Vision'
                  : navScope.level === 'goal'
                  ? 'No Tasks Inside This Goal'
                  : navScope.level === 'task'
                  ? 'No Subtasks Recorded'
                  : 'No Visions Recorded'}
              </div>
              <p className="text-xs text-[#B9AA9D]">
                Right-click anywhere on the canvas to add nodes, branching selectors, sticky notes,
                or grouping boxes.
              </p>
              {navScope.level !== 'root' && (
                <div className="flex items-center justify-center gap-2 pt-1">
                  <button
                    type="button"
                    onClick={handleBack}
                    className="px-3 py-1.5 bg-[#2A1D18] hover:bg-[#3A2821] border border-[#594238] text-[#F7F3EC] font-mono text-xs rounded-xs cursor-pointer"
                  >
                    Go Back
                  </button>
                  <button
                    type="button"
                    onClick={handleInspectCurrentScope}
                    className="px-3 py-1.5 bg-[#C83214] hover:bg-[#E04819] text-[#F7F3EC] font-mono text-xs rounded-xs cursor-pointer"
                  >
                    View Details
                  </button>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Sidebar Detail & Editor Panel */}
        {activeSelectedItem && (
          <aside
            aria-label="Vision, Goal, Task or Branching node details"
            className="absolute top-4 right-4 bottom-4 w-full max-w-sm z-30 bg-[#DFE4D8] text-[#18120F] border border-[#8C7263] shadow-2xl flex flex-col overflow-hidden rounded-sm"
          >
            <div className="px-5 py-4 border-b border-[#C5CBBF] flex items-start justify-between gap-3 bg-[#E5EAE0]">
              <div className="min-w-0">
                <div className="font-mono text-[11px] text-[#5D5046] truncate uppercase tracking-wider">
                  {activeSelectedItem.kind === 'vision'
                    ? `Vision · ${activeSelectedItem.data.readableKey}`
                    : activeSelectedItem.kind === 'goal'
                    ? `Goal · ${activeSelectedItem.data.readableKey}`
                    : activeSelectedItem.kind === 'task'
                    ? `Task · ${activeSelectedItem.data.readableKey}`
                    : activeSelectedItem.kind === 'branching'
                    ? `Branching · ${activeSelectedItem.data.kind.replace(/_/g, ' ')}`
                    : 'Flow Connection'}
                </div>
                <h2 className="font-display text-lg font-bold tracking-tight text-[#18120F] mt-0.5 truncate">
                  {activeSelectedItem.kind === 'edge'
                    ? activeSelectedItem.data.label || 'Flow Edge'
                    : activeSelectedItem.data.title}
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

            {activeSelectedItem.kind === 'edge' && (
              <div className="flex-1 overflow-y-auto p-5 space-y-4 text-xs">
                <div className="bg-[#D2D8CA] border border-[#B6BEAE] p-3 rounded-xs font-mono space-y-1">
                  <div>
                    <span className="text-[#6B5A4E]">From:</span> {activeSelectedItem.data.source}
                  </div>
                  <div>
                    <span className="text-[#6B5A4E]">To:</span> {activeSelectedItem.data.target}
                  </div>
                </div>
                <label className="flex flex-col gap-1 font-mono">
                  <span className="text-[11px] uppercase tracking-wider text-[#6B5A4E]">
                    Edge Label
                  </span>
                  <input
                    type="text"
                    value={activeSelectedItem.data.label || ''}
                    onChange={(e) => {
                      const val = e.target.value;
                      setCustomEdges((prev) => {
                        const next = prev.map((ce) =>
                          ce.id === activeSelectedItem.data.id ? { ...ce, label: val } : ce
                        );
                        saveCustomEdges(next);
                        return next;
                      });
                    }}
                    className="bg-[#EEF1EA] border border-[#9DA594] px-2.5 py-1.5 rounded-xs text-[#18120F]"
                  />
                </label>
                <button
                  type="button"
                  onClick={() => handleDeleteCustomEdge(activeSelectedItem.data.id)}
                  className="w-full inline-flex items-center justify-center gap-2 px-4 py-2 bg-[#B91C1C] hover:bg-[#991B1B] text-[#FEF2F2] font-mono text-xs font-semibold rounded-xs transition-colors cursor-pointer"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  <span>Delete Connection</span>
                </button>
              </div>
            )}

            {activeSelectedItem.kind === 'branching' && (
              <div className="flex-1 overflow-y-auto p-5 space-y-4 text-xs">
                <div className="flex items-center gap-2 font-mono text-[11px] text-[#5D5046] border-b border-[#C5CBBF] pb-2">
                  {activeSelectedItem.data.kind === 'multi_in_single_out' ? (
                    <GitMerge className="w-4 h-4 text-[#0E7490]" />
                  ) : activeSelectedItem.data.kind === 'single_in_multi_out' ? (
                    <GitBranch className="w-4 h-4 text-[#BE123C]" />
                  ) : (
                    <Split className="w-4 h-4 text-[#4D7C0F]" />
                  )}
                  <span className="uppercase font-semibold">
                    {activeSelectedItem.data.kind === 'multi_in_single_out'
                      ? 'Multi-In / Single-Out Selector'
                      : activeSelectedItem.data.kind === 'single_in_multi_out'
                      ? 'Single-In / Multi-Out Selector'
                      : 'Fan-Out Parallel Node'}
                  </span>
                </div>

                <label className="flex flex-col gap-1 font-mono">
                  <span className="text-[10px] uppercase tracking-wider text-[#6B5A4E]">Title</span>
                  <input
                    type="text"
                    aria-label="Branching node title"
                    value={activeSelectedItem.data.title}
                    onChange={(e) =>
                      updateBranchingNodeField(activeSelectedItem.data.id, { title: e.target.value })
                    }
                    className="bg-[#EEF1EA] border border-[#9DA594] px-2.5 py-1.5 rounded-xs text-[#18120F]"
                  />
                </label>

                <label className="flex flex-col gap-1 font-mono">
                  <span className="text-[10px] uppercase tracking-wider text-[#6B5A4E]">
                    Selection / Routing Rule
                  </span>
                  <input
                    type="text"
                    aria-label="Branching node rule"
                    value={activeSelectedItem.data.rule}
                    onChange={(e) =>
                      updateBranchingNodeField(activeSelectedItem.data.id, { rule: e.target.value })
                    }
                    className="bg-[#EEF1EA] border border-[#9DA594] px-2.5 py-1.5 rounded-xs text-[#18120F]"
                  />
                </label>

                <label className="flex flex-col gap-1 font-mono">
                  <span className="text-[10px] uppercase tracking-wider text-[#6B5A4E]">
                    {activeSelectedItem.data.kind === 'multi_in_single_out'
                      ? 'Input Ports (2–4)'
                      : 'Output Ports (2–4)'}
                  </span>
                  <select
                    aria-label="Branching port count"
                    value={activeSelectedItem.data.portCount}
                    onChange={(e) => {
                      const nextCount = Number(e.target.value);
                      const defaults = defaultPortLabelsForBranching(
                        activeSelectedItem.data.kind,
                        nextCount
                      );
                      const mergedLabels = defaults.map(
                        (def, i) => activeSelectedItem.data.portLabels[i] || def
                      );
                      updateBranchingNodeField(activeSelectedItem.data.id, {
                        portCount: nextCount,
                        portLabels: mergedLabels,
                      });
                    }}
                    className="bg-[#EEF1EA] border border-[#9DA594] px-2.5 py-1.5 rounded-xs text-[#18120F]"
                  >
                    <option value={2}>2 Ports</option>
                    <option value={3}>3 Ports</option>
                    <option value={4}>4 Ports</option>
                  </select>
                </label>

                <div className="space-y-1.5 font-mono">
                  <span className="text-[10px] uppercase tracking-wider text-[#6B5A4E]">
                    Port Labels
                  </span>
                  <div className="grid grid-cols-2 gap-1.5">
                    {activeSelectedItem.data.portLabels
                      .slice(0, activeSelectedItem.data.portCount)
                      .map((lbl, idx) => (
                        <input
                          key={`port-lbl-${idx}`}
                          type="text"
                          value={lbl}
                          onChange={(e) => {
                            const updated = [...activeSelectedItem.data.portLabels];
                            updated[idx] = e.target.value;
                            updateBranchingNodeField(activeSelectedItem.data.id, {
                              portLabels: updated,
                            });
                          }}
                          className="bg-[#EEF1EA] border border-[#9DA594] px-2 py-1 rounded-xs text-[11px] text-[#18120F]"
                        />
                      ))}
                  </div>
                </div>

                {renderSidebarAppearanceAndDeadline(
                  activeSelectedItem.data.id,
                  activeSelectedItem.data.kind,
                  { showDeadline: false }
                )}

                <div className="pt-2 border-t border-[#C5CBBF]">
                  <button
                    type="button"
                    onClick={() => handleDeleteNode(activeSelectedItem.data.id)}
                    className="w-full inline-flex items-center justify-center gap-2 px-4 py-2 bg-[#B91C1C] hover:bg-[#991B1B] text-[#FEF2F2] font-mono text-xs font-semibold rounded-xs transition-colors cursor-pointer"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    <span>Delete Branching Node</span>
                  </button>
                </div>
              </div>
            )}

            {activeSelectedItem.kind === 'vision' && (
              <div className="flex-1 overflow-y-auto p-5 space-y-4 text-xs">
                <div className="font-mono text-[11px] text-[#5D5046] border-b border-[#C5CBBF] pb-2 flex items-center justify-between tabular-nums">
                  <span>
                    Status:{' '}
                    <strong className="uppercase text-[#0F5132]">
                      {activeSelectedItem.data.status.replace('_', ' ')}
                    </strong>
                  </span>
                  <span>{activeSelectedItem.data.goalsCount} Goals</span>
                </div>
                {activeSelectedItem.isCustom && (
                  <div className="space-y-2 bg-[#D2D8CA] border border-[#B6BEAE] p-3 rounded-xs font-mono">
                    <label className="flex flex-col gap-1">
                      <span className="text-[10px] uppercase text-[#5D5046]">Title</span>
                      <input
                        type="text"
                        value={activeSelectedItem.data.title}
                        onChange={(e) =>
                          updateCustomDomainField(activeSelectedItem.data.id, {
                            title: e.target.value,
                          })
                        }
                        className="bg-[#EEF1EA] border border-[#9DA594] px-2 py-1 rounded-xs text-xs text-[#18120F]"
                      />
                    </label>
                    <label className="flex flex-col gap-1">
                      <span className="text-[10px] uppercase text-[#5D5046]">Description</span>
                      <textarea
                        rows={2}
                        value={activeSelectedItem.data.description}
                        onChange={(e) =>
                          updateCustomDomainField(activeSelectedItem.data.id, {
                            description: e.target.value,
                          })
                        }
                        className="bg-[#EEF1EA] border border-[#9DA594] px-2 py-1 rounded-xs text-xs text-[#18120F]"
                      />
                    </label>
                  </div>
                )}
                <div>
                  <h3 className="font-mono text-[11px] uppercase tracking-wider text-[#6B5A4E] mb-1.5">
                    Vision Description
                  </h3>
                  <p className="text-sm text-[#2C221D] leading-relaxed">
                    {activeSelectedItem.data.description || 'No description recorded.'}
                  </p>
                </div>
                <div>
                  <h3 className="font-mono text-[11px] uppercase tracking-wider text-[#6B5A4E] mb-1.5">
                    Target Alignment
                  </h3>
                  <div className="bg-[#D2D8CA] border border-[#B6BEAE] p-3 rounded-xs font-mono text-xs text-[#18120F]">
                    <div>
                      Type:{' '}
                      <strong className="text-[#0F5132]">
                        {activeSelectedItem.data.targetType}
                      </strong>
                    </div>
                    {activeSelectedItem.data.targetLabel && (
                      <div className="mt-1">Label: {activeSelectedItem.data.targetLabel}</div>
                    )}
                  </div>
                </div>
                {!(
                  navScope.level === 'vision' && navScope.visionId === activeSelectedItem.data.id
                ) && (
                  <div className="pt-1">
                    <button
                      type="button"
                      onClick={() => enterVision(activeSelectedItem.data.id)}
                      className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 bg-[#0F5132] hover:bg-[#146C43] text-[#ECFDF5] font-mono text-xs font-semibold rounded-xs transition-colors cursor-pointer"
                    >
                      <span>Open Goals Inside Vision</span>
                      <ArrowRight className="w-3.5 h-3.5" />
                    </button>
                  </div>
                )}
                {renderSidebarAppearanceAndDeadline(activeSelectedItem.data.id, 'vision', {
                  defaultStart: activeSelectedItem.data.createdAt,
                  defaultDeadline: activeSelectedItem.data.deadlineAt,
                  status: activeSelectedItem.data.status,
                })}
                {activeSelectedItem.isCustom && (
                  <button
                    type="button"
                    onClick={() => handleDeleteNode(activeSelectedItem.data.id)}
                    className="w-full inline-flex items-center justify-center gap-2 px-4 py-2 bg-[#B91C1C] hover:bg-[#991B1B] text-[#FEF2F2] font-mono text-xs font-semibold rounded-xs transition-colors cursor-pointer"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    <span>Delete Custom Vision</span>
                  </button>
                )}
              </div>
            )}

            {activeSelectedItem.kind === 'goal' && (
              <div className="flex-1 overflow-y-auto p-5 space-y-4 text-xs">
                <div className="font-mono text-[11px] text-[#5D5046] border-b border-[#C5CBBF] pb-2 flex items-center justify-between tabular-nums">
                  <span>
                    Status:{' '}
                    <strong className="uppercase text-[#B45309]">
                      {activeSelectedItem.data.status}
                    </strong>
                  </span>
                  <span>Progress: {activeSelectedItem.data.progress}%</span>
                </div>
                {activeSelectedItem.isCustom && (
                  <div className="space-y-2 bg-[#D2D8CA] border border-[#B6BEAE] p-3 rounded-xs font-mono">
                    <label className="flex flex-col gap-1">
                      <span className="text-[10px] uppercase text-[#5D5046]">Title</span>
                      <input
                        type="text"
                        value={activeSelectedItem.data.title}
                        onChange={(e) =>
                          updateCustomDomainField(activeSelectedItem.data.id, {
                            title: e.target.value,
                          })
                        }
                        className="bg-[#EEF1EA] border border-[#9DA594] px-2 py-1 rounded-xs text-xs text-[#18120F]"
                      />
                    </label>
                    <label className="flex flex-col gap-1">
                      <span className="text-[10px] uppercase text-[#5D5046]">Directive</span>
                      <textarea
                        rows={2}
                        value={activeSelectedItem.data.description || ''}
                        onChange={(e) =>
                          updateCustomDomainField(activeSelectedItem.data.id, {
                            description: e.target.value,
                          })
                        }
                        className="bg-[#EEF1EA] border border-[#9DA594] px-2 py-1 rounded-xs text-xs text-[#18120F]"
                      />
                    </label>
                  </div>
                )}
                <div>
                  <h3 className="font-mono text-[11px] uppercase tracking-wider text-[#6B5A4E] mb-1.5">
                    Goal Directive
                  </h3>
                  <p className="text-sm text-[#2C221D] leading-relaxed">
                    {activeSelectedItem.data.description || activeSelectedItem.data.title}
                  </p>
                </div>
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between font-mono text-[11px] text-[#5D5046] tabular-nums">
                    <span>
                      {activeSelectedItem.data.maxIterations > 0
                        ? `Loop ${activeSelectedItem.data.currentIteration} / ${activeSelectedItem.data.maxIterations}`
                        : `Iteration ${activeSelectedItem.data.currentIteration}`}
                    </span>
                    <span>{activeSelectedItem.data.tasksCount} Tasks</span>
                  </div>
                  <div className="w-full h-2 bg-[#C5CBBF] rounded-full overflow-hidden">
                    <div
                      className="h-full bg-[#B45309]"
                      style={{ width: `${activeSelectedItem.data.progress}%` }}
                    />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2 font-mono text-xs bg-[#D2D8CA] border border-[#B6BEAE] p-3 rounded-xs tabular-nums">
                  <div>
                    <span className="text-[#6B5A4E]">Priority:</span>{' '}
                    <strong className="text-[#18120F]">
                      {activeSelectedItem.data.priority.toFixed(2)}
                    </strong>
                  </div>
                  <div>
                    <span className="text-[#6B5A4E]">Notoriety:</span>{' '}
                    <strong className="text-[#18120F]">
                      {activeSelectedItem.data.blockerNotoriety}
                    </strong>
                  </div>
                  <div>
                    <span className="text-[#6B5A4E]">Type:</span>{' '}
                    <strong className="text-[#18120F]">{activeSelectedItem.data.goalType}</strong>
                  </div>
                  {activeSelectedItem.data.systemKey && (
                    <div className="truncate">
                      <span className="text-[#6B5A4E]">System:</span>{' '}
                      <strong className="text-[#18120F]">{activeSelectedItem.data.systemKey}</strong>
                    </div>
                  )}
                </div>
                {!(navScope.level === 'goal' && navScope.goalId === activeSelectedItem.data.id) && (
                  <div className="pt-1">
                    <button
                      type="button"
                      onClick={() => enterGoal(activeSelectedItem.data.id)}
                      className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 bg-[#B45309] hover:bg-[#92400E] text-[#FEF3C7] font-mono text-xs font-semibold rounded-xs transition-colors cursor-pointer"
                    >
                      <span>Open Tasks Inside Goal</span>
                      <ArrowRight className="w-3.5 h-3.5" />
                    </button>
                  </div>
                )}
                {renderSidebarAppearanceAndDeadline(activeSelectedItem.data.id, 'goal', {
                  defaultStart: activeSelectedItem.data.createdAt,
                  defaultDeadline: activeSelectedItem.data.deadlineAt,
                  status: activeSelectedItem.data.status,
                })}
                {activeSelectedItem.isCustom && (
                  <button
                    type="button"
                    onClick={() => handleDeleteNode(activeSelectedItem.data.id)}
                    className="w-full inline-flex items-center justify-center gap-2 px-4 py-2 bg-[#B91C1C] hover:bg-[#991B1B] text-[#FEF2F2] font-mono text-xs font-semibold rounded-xs transition-colors cursor-pointer"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    <span>Delete Custom Goal</span>
                  </button>
                )}
              </div>
            )}

            {activeSelectedItem.kind === 'task' && (
              <div className="flex-1 overflow-y-auto p-5 space-y-4 text-xs">
                <div className="font-mono text-[11px] text-[#5D5046] border-b border-[#C5CBBF] pb-2 flex items-center justify-between gap-2">
                  <span>
                    Status:{' '}
                    <strong className="uppercase text-[#0369A1]">
                      {activeSelectedItem.data.status}
                    </strong>
                  </span>
                  <span
                    className={`px-2 py-0.5 border rounded-xs font-mono text-[10px] ${leaseBadgeClass(
                      activeSelectedItem.data.occupancy.leaseState
                    )}`}
                  >
                    {leaseLabel(activeSelectedItem.data.occupancy.leaseState)}
                  </span>
                </div>

                {activeSelectedItem.isCustom && (
                  <div className="space-y-2 bg-[#D2D8CA] border border-[#B6BEAE] p-3 rounded-xs font-mono">
                    <label className="flex flex-col gap-1">
                      <span className="text-[10px] uppercase text-[#5D5046]">Title</span>
                      <input
                        type="text"
                        value={activeSelectedItem.data.title}
                        onChange={(e) =>
                          updateCustomDomainField(activeSelectedItem.data.id, {
                            title: e.target.value,
                          })
                        }
                        className="bg-[#EEF1EA] border border-[#9DA594] px-2 py-1 rounded-xs text-xs text-[#18120F]"
                      />
                    </label>
                    <label className="flex flex-col gap-1">
                      <span className="text-[10px] uppercase text-[#5D5046]">Specification</span>
                      <textarea
                        rows={2}
                        value={activeSelectedItem.data.description || ''}
                        onChange={(e) =>
                          updateCustomDomainField(activeSelectedItem.data.id, {
                            description: e.target.value,
                          })
                        }
                        className="bg-[#EEF1EA] border border-[#9DA594] px-2 py-1 rounded-xs text-xs text-[#18120F]"
                      />
                    </label>
                  </div>
                )}

                <div className="flex items-center justify-between font-mono text-[11px] text-[#5D5046]">
                  <span>
                    Type:{' '}
                    <strong className="text-[#18120F]">{activeSelectedItem.data.taskType}</strong>
                  </span>
                  <span>
                    Verification:{' '}
                    <strong className="text-[#18120F]">
                      {activeSelectedItem.data.verificationStatus}
                    </strong>
                  </span>
                </div>

                {activeSelectedItem.data.occupancy.agentDisplayLabel && (
                  <div className="bg-[#D2D8CA] border border-[#B6BEAE] px-3 py-2 rounded-xs font-mono text-[11px] text-[#18120F] truncate">
                    Holder: {activeSelectedItem.data.occupancy.agentDisplayLabel}
                  </div>
                )}

                <div>
                  <h3 className="font-mono text-[11px] uppercase tracking-wider text-[#6B5A4E] mb-1.5">
                    Task Specification
                  </h3>
                  <p className="text-sm text-[#2C221D] leading-relaxed">
                    {activeSelectedItem.data.description || activeSelectedItem.data.title}
                  </p>
                </div>

                {!(navScope.level === 'task' && navScope.taskId === activeSelectedItem.data.id) && (
                  <div>
                    <button
                      type="button"
                      onClick={() => enterTask(activeSelectedItem.data.id)}
                      className="w-full inline-flex items-center justify-center gap-2 px-4 py-2 bg-[#0369A1] hover:bg-[#075985] text-[#F0F9FF] font-mono text-xs font-semibold rounded-xs transition-colors cursor-pointer"
                    >
                      <span>Focus Task Scope</span>
                      <ArrowRight className="w-3.5 h-3.5" />
                    </button>
                  </div>
                )}

                <div>
                  <h3 className="font-mono text-[11px] uppercase tracking-wider text-[#6B5A4E] mb-1.5">
                    Evaluation Script
                  </h3>
                  <pre className="bg-[#18120F] text-[#7DD3FC] p-3 font-mono text-[11px] rounded-xs whitespace-pre-wrap break-all">
                    {activeSelectedItem.data.evalScript || 'No evaluation script recorded.'}
                  </pre>
                </div>

                <div className="grid grid-cols-2 gap-2 text-[11px] font-mono bg-[#D2D8CA] border border-[#B6BEAE] p-3 rounded-xs">
                  <div className="min-w-0">
                    <div className="uppercase tracking-wider text-[#6B5A4E] text-[10px] mb-1">
                      Inputs
                    </div>
                    {activeSelectedItem.data.inputs.length === 0 ? (
                      <span className="text-[#6B5A4E]">None</span>
                    ) : (
                      <ul className="space-y-0.5 text-[#18120F]">
                        {activeSelectedItem.data.inputs.map((inp) => (
                          <li key={inp} className="truncate">
                            {inp}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                  <div className="min-w-0 border-l border-[#B6BEAE] pl-2">
                    <div className="uppercase tracking-wider text-[#6B5A4E] text-[10px] mb-1">
                      Outputs
                    </div>
                    {activeSelectedItem.data.outputs.length === 0 ? (
                      <span className="text-[#6B5A4E]">None</span>
                    ) : (
                      <ul className="space-y-0.5 text-[#18120F]">
                        {activeSelectedItem.data.outputs.map((out) => (
                          <li key={out} className="truncate">
                            {out}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>

                {activeSelectedItem.data.contextLimit && (
                  <div className="pt-2 border-t border-[#C5CBBF] space-y-1.5">
                    {(() => {
                      const ctx = formatContextUsage(activeSelectedItem.data.contextLimit);
                      return (
                        <>
                          <div className="flex items-center justify-between text-[11px] font-mono tabular-nums">
                            <span className="uppercase tracking-wider text-[#6B5A4E]">
                              Context Budget
                            </span>
                            <span className="text-[#18120F] font-semibold">
                              {ctx.usedLabel} / {ctx.maxLabel} ({ctx.percent}%)
                            </span>
                          </div>
                          <div className="w-full h-2 bg-[#C5CBBF] rounded-full overflow-hidden">
                            <div
                              className={`h-full ${
                                ctx.percent >= 75 ? 'bg-[#C83214]' : 'bg-[#0369A1]'
                              }`}
                              style={{ width: `${ctx.percent}%` }}
                            />
                          </div>
                        </>
                      );
                    })()}
                  </div>
                )}

                {activeSelectedItem.data.checkpoints.length > 0 && (
                  <div className="pt-2 border-t border-[#C5CBBF] space-y-2">
                    <h3 className="font-mono text-[11px] uppercase tracking-wider text-[#6B5A4E]">
                      Checkpoints ({activeSelectedItem.data.checkpoints.length})
                    </h3>
                    <div className="space-y-1.5">
                      {activeSelectedItem.data.checkpoints.map((cp) => (
                        <div
                          key={cp.parameterId}
                          className="bg-[#D2D8CA] border border-[#B6BEAE] p-2 rounded-xs font-mono text-[11px]"
                        >
                          <div className="flex items-center justify-between text-[10px] text-[#5D5046]">
                            <span>{cp.predicateKey || cp.parameterId}</span>
                            <span className="uppercase font-semibold">{cp.status}</span>
                          </div>
                          <div className="text-[#18120F] mt-0.5">{cp.objective}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {renderSidebarAppearanceAndDeadline(activeSelectedItem.data.id, 'task', {
                  defaultStart: activeSelectedItem.data.startedAt,
                  defaultDeadline: activeSelectedItem.data.dueAt,
                  status: activeSelectedItem.data.status,
                })}

                {activeSelectedItem.isCustom && (
                  <button
                    type="button"
                    onClick={() => handleDeleteNode(activeSelectedItem.data.id)}
                    className="w-full inline-flex items-center justify-center gap-2 px-4 py-2 bg-[#B91C1C] hover:bg-[#991B1B] text-[#FEF2F2] font-mono text-xs font-semibold rounded-xs transition-colors cursor-pointer"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    <span>Delete Custom Task</span>
                  </button>
                )}
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
      <VisionsGoalsGraphCanvas {...props} />
    </ReactFlowProvider>
  );
}
