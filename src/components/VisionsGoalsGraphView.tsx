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
  AlertTriangle,
  ArrowRight,
  ChevronLeft,
  ChevronRight,
  Compass,
  Flag,
  Info,
  Loader2,
  Maximize2,
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
  VisionGraphNodeData,
  VisionsGoalsSubstrateResponse,
} from '../types/substrate';
import {
  buildVisionsGoalsGraph,
  formatContextUsage,
  type VisionsGoalsScope,
} from '../utils/graphData';
import { useFloatyForceLayout } from '../hooks/useFloatyForceLayout';
import { IconButton } from './IconButton';

interface VisionsGoalsGraphViewProps {
  refreshTick?: number;
  onLoadingChange?: (loading: boolean) => void;
}

type SelectedGraphItem =
  | { kind: 'vision'; data: VisionGraphNodeData }
  | { kind: 'goal'; data: GoalGraphNodeData }
  | { kind: 'task'; data: TaskGraphNodeData };

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

/**
 * VISION NODE — Tall Domed Portal / Archway (Emerald & Mint Ivory)
 * Single click -> Details Panel; Double click -> Enter Vision to view its Goals.
 */
function VisionNode({ data, selected }: NodeProps) {
  const vision = data as unknown as VisionGraphNodeData;

  return (
    <div
      data-node-id={vision.id}
      className={`group relative w-full h-full rounded-t-[44px] rounded-b-lg border-2 transition-all duration-150 cursor-pointer select-none shadow-xl flex flex-col justify-between px-5 pt-3.5 pb-3 ${
        selected
          ? 'bg-[#0F3225] border-[#6EE7B7] ring-2 ring-[#34D399]/60 shadow-[0_0_24px_rgba(52,211,153,0.22)]'
          : 'bg-[#092018] border-[#22C58B]/80 hover:border-[#6EE7B7] hover:bg-[#0D2B20]'
      }`}
    >
      {/* Inner double-arch architectural hairline */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-[5px] rounded-t-[39px] rounded-b-[6px] border border-[#34D399]/25"
      />

      <Handle
        type="target"
        position={Position.Left}
        className="!w-3 !h-3 !bg-[#34D399] !border-2 !border-[#092018] !rounded-full"
      />

      {/* Crown Kicker */}
      <div className="relative z-10 flex items-center justify-between gap-2 text-[10px] font-mono text-[#6EE7B7]">
        <span className="inline-flex items-center gap-1.5 font-semibold tracking-wider uppercase">
          <Compass className="w-3.5 h-3.5 text-[#34D399] shrink-0" />
          <span>Vision · {vision.readableKey}</span>
        </span>
        <span className="uppercase text-[#A7F3D0]/85">{vision.status.replace('_', ' ')}</span>
      </div>

      {/* Main Title & Target */}
      <div className="relative z-10 my-auto py-1">
        <h3 className="font-display text-sm font-bold leading-snug text-[#ECFDF5] line-clamp-2">
          {vision.title}
        </h3>
        {vision.description && (
          <p className="text-[11px] text-[#A7F3D0]/75 truncate mt-0.5">{vision.description}</p>
        )}
      </div>

      {/* Footer Horizon Meta */}
      <div className="relative z-10 pt-1.5 border-t border-[#34D399]/20 flex items-center justify-between gap-2 text-[11px] font-mono">
        <span className="text-[#A7F3D0]/80 truncate">
          {vision.targetLabel ? `${vision.targetType}: ${vision.targetLabel}` : vision.targetType}
        </span>
        <span className="inline-flex items-center gap-1 font-semibold text-[#6EE7B7] shrink-0 tabular-nums">
          <span>{vision.goalsCount} goals</span>
          <ArrowRight className="w-3 h-3 opacity-70 group-hover:translate-x-0.5 transition-transform" />
        </span>
      </div>

      <Handle
        type="source"
        position={Position.Right}
        className="!w-3 !h-3 !bg-[#34D399] !border-2 !border-[#092018] !rounded-full"
      />
    </div>
  );
}

/**
 * GOAL NODE — Faceted Pointed Hexagon (Burnished Amber & Solar Gold)
 * Single click -> Details Panel; Double click -> Enter Goal to view its Tasks.
 */
function GoalNode({ data, selected }: NodeProps) {
  const goal = data as unknown as GoalGraphNodeData;
  const isDone = goal.status === 'verified' || goal.status === 'completed';

  return (
    <div
      data-node-id={goal.id}
      className="group relative w-full h-full cursor-pointer select-none"
    >
      {/* Sharp SVG Pointed Hexagon Body (304 x 118) */}
      <svg
        viewBox="0 0 304 118"
        className="absolute inset-0 w-full h-full pointer-events-none overflow-visible drop-shadow-[0_10px_18px_rgba(0,0,0,0.45)]"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <polygon
          points="24,2 280,2 302,59 280,116 24,116 2,59"
          fill={selected ? '#321D06' : '#241505'}
          stroke={selected ? '#FCD34D' : '#F59E0B'}
          strokeWidth={selected ? 2.5 : 1.75}
          strokeLinejoin="miter"
          className="transition-colors duration-150 group-hover:fill-[#2D1A06] group-hover:stroke-[#FBBF24]"
        />
        <polygon
          points="27,7 277,7 296,59 277,111 27,111 8,59"
          fill="none"
          stroke="#F59E0B"
          strokeOpacity={0.22}
          strokeWidth={1}
        />
      </svg>

      <Handle
        type="target"
        position={Position.Left}
        className="!w-3 !h-3 !bg-[#F59E0B] !border-2 !border-[#241505] !rounded-full"
      />

      <div className="relative z-10 w-full h-full flex flex-col justify-between px-8 py-3">
        <div className="flex items-center justify-between gap-2 text-[10px] font-mono text-[#FCD34D]">
          <span className="inline-flex items-center gap-1.5 font-semibold tracking-wider uppercase truncate">
            <Flag className="w-3.5 h-3.5 text-[#F59E0B] shrink-0" />
            <span>Goal · {goal.readableKey}</span>
          </span>
          <span className="uppercase text-[#FDE68A]/85 shrink-0">{goal.status}</span>
        </div>

        <h3 className="font-display text-sm font-bold leading-snug text-[#FEF3C7] line-clamp-2 my-auto">
          {goal.title}
        </h3>

        <div className="space-y-1">
          <div className="w-full h-1.5 bg-[#160C02] rounded-full overflow-hidden border border-[#F59E0B]/30">
            <div
              className={`h-full transition-all ${isDone ? 'bg-[#34D399]' : 'bg-[#F59E0B]'}`}
              style={{ width: `${goal.progress}%` }}
            />
          </div>
          <div className="flex items-center justify-between text-[10px] font-mono text-[#FDE68A]/80 tabular-nums">
            <span>
              {goal.maxIterations > 0
                ? `Loop ${goal.currentIteration}/${goal.maxIterations} · ${goal.progress}%`
                : `Iter ${goal.currentIteration} · ${goal.progress}%`}
            </span>
            <span className="inline-flex items-center gap-1 font-semibold text-[#FCD34D]">
              <span>{goal.tasksCount} tasks</span>
              <ArrowRight className="w-3 h-3 opacity-70 group-hover:translate-x-0.5 transition-transform" />
            </span>
          </div>
        </div>
      </div>

      <Handle
        type="source"
        position={Position.Right}
        className="!w-3 !h-3 !bg-[#F59E0B] !border-2 !border-[#241505] !rounded-full"
      />
    </div>
  );
}

/**
 * TASK NODE — Dog-Ear Notched Engineering Ticket (Deep Cobalt & Sky Cyan)
 * Single click -> Details Panel.
 */
function TaskNode({ data, selected }: NodeProps) {
  const task = data as unknown as TaskGraphNodeData;
  const ctx = task.contextLimit ? formatContextUsage(task.contextLimit) : null;

  return (
    <div
      data-node-id={task.id}
      className="group relative w-full h-full cursor-pointer select-none"
    >
      {/* Dog-ear Notched Ticket SVG Body (276 x 98) */}
      <svg
        viewBox="0 0 276 98"
        className="absolute inset-0 w-full h-full pointer-events-none overflow-visible drop-shadow-[0_8px_14px_rgba(0,0,0,0.45)]"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <polygon
          points="2,2 254,2 274,22 274,96 2,96"
          fill={selected ? '#132642' : '#0B1626'}
          stroke={selected ? '#7DD3FC' : '#38BDF8'}
          strokeWidth={selected ? 2.5 : 1.75}
          strokeLinejoin="miter"
          className="transition-colors duration-150 group-hover:fill-[#102038] group-hover:stroke-[#7DD3FC]"
        />
        {/* Dog-ear fold crease */}
        <polygon
          points="254,2 254,22 274,22"
          fill="#172B47"
          stroke={selected ? '#7DD3FC' : '#38BDF8'}
          strokeWidth={1.25}
          strokeLinejoin="miter"
        />
      </svg>

      <Handle
        type="target"
        position={Position.Left}
        className="!w-2.5 !h-2.5 !bg-[#38BDF8] !border-2 !border-[#0B1626] !rounded-none"
      />

      <div className="relative z-10 w-full h-full flex flex-col justify-between px-4 py-2.5 pr-6">
        <div className="flex items-center justify-between gap-2 text-[10px] font-mono text-[#7DD3FC]">
          <span className="inline-flex items-center gap-1.5 font-semibold tracking-wider uppercase truncate">
            <Terminal className="w-3.5 h-3.5 text-[#38BDF8] shrink-0" />
            <span>Task · {task.readableKey}</span>
          </span>
          <span className="uppercase text-[#BAE6FD]/80 shrink-0">{task.status}</span>
        </div>

        <h3 className="font-display text-xs font-semibold leading-snug text-[#F0F9FF] line-clamp-2 my-auto">
          {task.title}
        </h3>

        <div className="pt-1 border-t border-[#38BDF8]/20 flex items-center justify-between gap-2 text-[10px] font-mono text-[#BAE6FD]/75 tabular-nums">
          <span className="truncate">{leaseLabel(task.occupancy.leaseState)}</span>
          {ctx ? (
            <span className="text-[#7DD3FC] shrink-0">{ctx.percent}% ctx</span>
          ) : (
            <span className="text-[#7DD3FC]/70 truncate shrink-0">{task.taskType}</span>
          )}
        </div>
      </div>

      <Handle
        type="source"
        position={Position.Right}
        className="!w-2.5 !h-2.5 !bg-[#38BDF8] !border-2 !border-[#0B1626] !rounded-none"
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

  const [navScope, setNavScope] = useState<VisionsGoalsScope>({ level: 'root' });
  const [selectedItem, setSelectedItem] = useState<SelectedGraphItem | null>(null);

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
      scope: navScope,
    });
  }, [substrateData, navScope]);

  const [nodes, setNodes, onNodesChange] = useNodesState(initialGraph.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialGraph.edges);

  const {
    onNodeDragStart,
    onNodeDrag,
    onNodeDragStop,
    onNodeMouseEnter,
    onNodeMouseLeave,
    resetBodies,
  } = useFloatyForceLayout({
    baseNodes: initialGraph.nodes,
    edges,
    setNodes,
    enabled: true,
    amplitude: 4.2,
  });

  useEffect(() => {
    setNodes(initialGraph.nodes);
    setEdges(initialGraph.edges);
    resetBodies(initialGraph.nodes, true);
    const timer = window.setTimeout(() => {
      fitView({ padding: 0.22, duration: 220, maxZoom: 1.15 });
    }, 90);
    return () => window.clearTimeout(timer);
  }, [initialGraph, setNodes, setEdges, resetBodies, fitView]);

  const clickTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (clickTimerRef.current !== null) window.clearTimeout(clickTimerRef.current);
    };
  }, []);

  const enterVision = useCallback((visionId: string) => {
    setSelectedItem(null);
    setNavScope({ level: 'vision', visionId });
  }, []);

  const enterGoal = useCallback((goalId: string) => {
    setSelectedItem(null);
    setNavScope({ level: 'goal', goalId });
  }, []);

  const handleNodeClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      if (clickTimerRef.current !== null) {
        window.clearTimeout(clickTimerRef.current);
        clickTimerRef.current = null;
      }
      clickTimerRef.current = window.setTimeout(() => {
        clickTimerRef.current = null;
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
      }, 200);
    },
    [substrateData]
  );

  const handleNodeDoubleClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      if (clickTimerRef.current !== null) {
        window.clearTimeout(clickTimerRef.current);
        clickTimerRef.current = null;
      }
      if (node.type === 'visionNode') {
        enterVision(node.id);
      } else if (node.type === 'goalNode') {
        enterGoal(node.id);
      } else if (node.type === 'taskNode' && substrateData) {
        const found = substrateData.tasks.find((t) => t.id === node.id);
        if (found) setSelectedItem({ kind: 'task', data: found });
      }
    },
    [enterVision, enterGoal, substrateData]
  );

  // Derive active hierarchy strictly from current nested navigation scope
  const scopedGoal = useMemo(() => {
    if (navScope.level !== 'goal' || !substrateData) return null;
    return substrateData.goals.find((g) => g.id === navScope.goalId) || null;
  }, [navScope, substrateData]);

  const scopedVision = useMemo(() => {
    if (!substrateData) return null;
    if (navScope.level === 'vision') {
      return substrateData.visions.find((v) => v.id === navScope.visionId) || null;
    }
    if (navScope.level === 'goal' && scopedGoal?.visionId) {
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
        label: 'Visions & Goals',
        icon: Target,
        onClick: () => {
          setSelectedItem(null);
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
          setNavScope({ level: 'vision', visionId: scopedVision.id });
        },
      });
    }

    if (scopedGoal) {
      crumbs.push({
        id: scopedGoal.id,
        label: scopedGoal.title,
        icon: Flag,
      });
    }

    return crumbs;
  }, [scopedVision, scopedGoal]);

  const handleBack = useCallback(() => {
    setSelectedItem(null);
    if (navScope.level === 'goal') {
      if (scopedVision) {
        setNavScope({ level: 'vision', visionId: scopedVision.id });
      } else {
        setNavScope({ level: 'root' });
      }
    } else if (navScope.level === 'vision') {
      setNavScope({ level: 'root' });
    }
  }, [navScope.level, scopedVision]);

  const handleInspectCurrentScope = useCallback(() => {
    if (navScope.level === 'goal' && scopedGoal) {
      setSelectedItem({ kind: 'goal', data: scopedGoal });
    } else if (navScope.level === 'vision' && scopedVision) {
      setSelectedItem({ kind: 'vision', data: scopedVision });
    }
  }, [navScope.level, scopedGoal, scopedVision]);

  const handleReset = useCallback(() => {
    setSelectedItem(null);
    resetBodies(initialGraph.nodes, true);
    setNodes(initialGraph.nodes);
    setEdges(initialGraph.edges);
    window.setTimeout(() => fitView({ padding: 0.22, duration: 220, maxZoom: 1.15 }), 60);
  }, [initialGraph, resetBodies, setNodes, setEdges, fitView]);

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
      {/* Top Canvas Bar: Nested Breadcrumbs on Left, Clean Controls on Right */}
      <div className="h-14 shrink-0 px-4 border-b border-[#382821] bg-[#18100D] flex items-center justify-between gap-4 z-20">
        <nav
          aria-label="Visions nesting hierarchy"
          className="flex items-center gap-1.5 min-w-0 max-w-[68%] overflow-x-auto py-1"
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
                  {isLast ? (
                    <span
                      aria-current="location"
                      className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-xs bg-[#241814] text-[#F7F3EC] border border-[#594238] font-semibold truncate max-w-[260px]"
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

          {navScope.level !== 'root' && (
            <IconButton
              label={
                navScope.level === 'goal'
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

        {/* Right: Interaction Legend + Viewport Controls */}
        <div className="flex items-center gap-1.5 shrink-0">
          <span className="hidden lg:inline-block font-mono text-[11px] text-[#8C7263] mr-2 whitespace-nowrap">
            Click: details · Double-click: open inside
          </span>
          <IconButton label="Zoom In" onClick={() => zoomIn({ duration: 150 })}>
            <ZoomIn className="w-4 h-4" />
          </IconButton>
          <IconButton label="Zoom Out" onClick={() => zoomOut({ duration: 150 })}>
            <ZoomOut className="w-4 h-4" />
          </IconButton>
          <IconButton
            label="Fit View"
            onClick={() => fitView({ padding: 0.22, duration: 220, maxZoom: 1.15 })}
          >
            <Maximize2 className="w-4 h-4" />
          </IconButton>
          <div className="w-px h-6 bg-[#3D2B24] mx-1" />
          <IconButton label="Reset Node Positions" onClick={handleReset}>
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
            onPaneClick={() => setSelectedItem(null)}
            fitView
            fitViewOptions={{ padding: 0.22 }}
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
                  ? '#10B981'
                  : n.type === 'goalNode'
                  ? '#F59E0B'
                  : '#38BDF8'
              }
              maskColor="rgba(20, 13, 11, 0.72)"
            />
          </ReactFlow>
        </div>

        {/* Empty Nested Level State */}
        {!loading && nodes.length === 0 && (
          <div className="absolute inset-0 z-20 flex items-center justify-center pointer-events-none">
            <div className="pointer-events-auto border border-[#433129] bg-[#1D1411] px-6 py-5 rounded-sm text-center space-y-3 max-w-md shadow-2xl">
              <div className="font-display text-base font-semibold text-[#F7F3EC]">
                {navScope.level === 'vision'
                  ? 'No Goals Inside This Vision'
                  : navScope.level === 'goal'
                  ? 'No Tasks Inside This Goal'
                  : 'No Visions, Goals, or Tasks Recorded'}
              </div>
              <p className="text-xs text-[#B9AA9D]">
                {navScope.level === 'vision'
                  ? 'This vision does not have any attached goals in the substrate yet.'
                  : navScope.level === 'goal'
                  ? 'This goal does not have any child tasks in the substrate yet.'
                  : 'The connected Supabase ledger returned zero active visions, goals, or tasks.'}
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

        {/* Sidebar Detail Panel (Single Click) */}
        {selectedItem && (
          <aside
            aria-label="Vision, Goal or Task details"
            className="absolute top-4 right-4 bottom-4 w-full max-w-sm z-30 bg-[#DFE4D8] text-[#18120F] border border-[#8C7263] shadow-2xl flex flex-col overflow-hidden rounded-sm"
          >
            <div className="px-5 py-4 border-b border-[#C5CBBF] flex items-start justify-between gap-3 bg-[#E5EAE0]">
              <div className="min-w-0">
                <div className="font-mono text-[11px] text-[#5D5046] truncate uppercase tracking-wider">
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
                <div className="font-mono text-[11px] text-[#5D5046] border-b border-[#C5CBBF] pb-2 flex items-center justify-between tabular-nums">
                  <span>
                    Status: <strong className="uppercase text-[#0F5132]">{selectedItem.data.status.replace('_', ' ')}</strong>
                  </span>
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
                    <div>
                      Type: <strong className="text-[#0F5132]">{selectedItem.data.targetType}</strong>
                    </div>
                    {selectedItem.data.targetLabel && (
                      <div className="mt-1">Label: {selectedItem.data.targetLabel}</div>
                    )}
                  </div>
                </div>
                {!(navScope.level === 'vision' && navScope.visionId === selectedItem.data.id) && (
                  <div className="pt-2">
                    <button
                      type="button"
                      onClick={() => enterVision(selectedItem.data.id)}
                      className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 bg-[#0F5132] hover:bg-[#146C43] text-[#ECFDF5] font-mono text-xs font-semibold rounded-xs transition-colors cursor-pointer"
                    >
                      <span>Open Goals Inside Vision</span>
                      <ArrowRight className="w-3.5 h-3.5" />
                    </button>
                  </div>
                )}
              </div>
            )}

            {selectedItem.kind === 'goal' && (
              <div className="flex-1 overflow-y-auto p-5 space-y-4 text-xs">
                <div className="font-mono text-[11px] text-[#5D5046] border-b border-[#C5CBBF] pb-2 flex items-center justify-between tabular-nums">
                  <span>
                    Status: <strong className="uppercase text-[#B45309]">{selectedItem.data.status}</strong>
                  </span>
                  <span>Progress: {selectedItem.data.progress}%</span>
                </div>
                <div>
                  <h3 className="font-mono text-[11px] uppercase tracking-wider text-[#6B5A4E] mb-1.5">
                    Goal Directive
                  </h3>
                  <p className="text-sm text-[#2C221D] leading-relaxed">
                    {selectedItem.data.description || selectedItem.data.title}
                  </p>
                </div>
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between font-mono text-[11px] text-[#5D5046] tabular-nums">
                    <span>
                      {selectedItem.data.maxIterations > 0
                        ? `Loop ${selectedItem.data.currentIteration} / ${selectedItem.data.maxIterations}`
                        : `Iteration ${selectedItem.data.currentIteration}`}
                    </span>
                    <span>{selectedItem.data.tasksCount} Tasks</span>
                  </div>
                  <div className="w-full h-2 bg-[#C5CBBF] rounded-full overflow-hidden">
                    <div
                      className="h-full bg-[#B45309]"
                      style={{ width: `${selectedItem.data.progress}%` }}
                    />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2 font-mono text-xs bg-[#D2D8CA] border border-[#B6BEAE] p-3 rounded-xs tabular-nums">
                  <div>
                    <span className="text-[#6B5A4E]">Priority:</span>{' '}
                    <strong className="text-[#18120F]">{selectedItem.data.priority.toFixed(2)}</strong>
                  </div>
                  <div>
                    <span className="text-[#6B5A4E]">Notoriety:</span>{' '}
                    <strong className="text-[#18120F]">{selectedItem.data.blockerNotoriety}</strong>
                  </div>
                  <div>
                    <span className="text-[#6B5A4E]">Type:</span>{' '}
                    <strong className="text-[#18120F]">{selectedItem.data.goalType}</strong>
                  </div>
                  {selectedItem.data.systemKey && (
                    <div className="truncate">
                      <span className="text-[#6B5A4E]">System:</span>{' '}
                      <strong className="text-[#18120F]">{selectedItem.data.systemKey}</strong>
                    </div>
                  )}
                </div>
                {!(navScope.level === 'goal' && navScope.goalId === selectedItem.data.id) && (
                  <div className="pt-2">
                    <button
                      type="button"
                      onClick={() => enterGoal(selectedItem.data.id)}
                      className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 bg-[#B45309] hover:bg-[#92400E] text-[#FEF3C7] font-mono text-xs font-semibold rounded-xs transition-colors cursor-pointer"
                    >
                      <span>Open Tasks Inside Goal</span>
                      <ArrowRight className="w-3.5 h-3.5" />
                    </button>
                  </div>
                )}
              </div>
            )}

            {selectedItem.kind === 'task' && (
              <div className="flex-1 overflow-y-auto p-5 space-y-4 text-xs">
                <div className="font-mono text-[11px] text-[#5D5046] border-b border-[#C5CBBF] pb-2 flex items-center justify-between gap-2">
                  <span>
                    Status: <strong className="uppercase text-[#0369A1]">{selectedItem.data.status}</strong>
                  </span>
                  <span
                    className={`px-2 py-0.5 border rounded-xs font-mono text-[10px] ${leaseBadgeClass(
                      selectedItem.data.occupancy.leaseState
                    )}`}
                  >
                    {leaseLabel(selectedItem.data.occupancy.leaseState)}
                  </span>
                </div>

                <div className="flex items-center justify-between font-mono text-[11px] text-[#5D5046]">
                  <span>Type: <strong className="text-[#18120F]">{selectedItem.data.taskType}</strong></span>
                  <span>Verification: <strong className="text-[#18120F]">{selectedItem.data.verificationStatus}</strong></span>
                </div>

                {selectedItem.data.occupancy.agentDisplayLabel && (
                  <div className="bg-[#D2D8CA] border border-[#B6BEAE] px-3 py-2 rounded-xs font-mono text-[11px] text-[#18120F] truncate">
                    Holder: {selectedItem.data.occupancy.agentDisplayLabel}
                  </div>
                )}

                <div>
                  <h3 className="font-mono text-[11px] uppercase tracking-wider text-[#6B5A4E] mb-1.5">
                    Task Specification
                  </h3>
                  <p className="text-sm text-[#2C221D] leading-relaxed">
                    {selectedItem.data.description || selectedItem.data.title}
                  </p>
                </div>

                <div>
                  <h3 className="font-mono text-[11px] uppercase tracking-wider text-[#6B5A4E] mb-1.5">
                    Evaluation Script
                  </h3>
                  <pre className="bg-[#18120F] text-[#7DD3FC] p-3 font-mono text-[11px] rounded-xs whitespace-pre-wrap break-all">
                    {selectedItem.data.evalScript || 'No evaluation script recorded.'}
                  </pre>
                </div>

                <div className="grid grid-cols-2 gap-2 text-[11px] font-mono bg-[#D2D8CA] border border-[#B6BEAE] p-3 rounded-xs">
                  <div className="min-w-0">
                    <div className="uppercase tracking-wider text-[#6B5A4E] text-[10px] mb-1">
                      Inputs
                    </div>
                    {selectedItem.data.inputs.length === 0 ? (
                      <span className="text-[#6B5A4E]">None</span>
                    ) : (
                      <ul className="space-y-0.5 text-[#18120F]">
                        {selectedItem.data.inputs.map((inp) => (
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
                    {selectedItem.data.outputs.length === 0 ? (
                      <span className="text-[#6B5A4E]">None</span>
                    ) : (
                      <ul className="space-y-0.5 text-[#18120F]">
                        {selectedItem.data.outputs.map((out) => (
                          <li key={out} className="truncate">
                            {out}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>

                <div>
                  <h3 className="font-mono text-[11px] uppercase tracking-wider text-[#6B5A4E] mb-1.5">
                    Tools Available
                  </h3>
                  {selectedItem.data.toolsAvailable.length === 0 ? (
                    <p className="font-mono text-[11px] text-[#6B5A4E]">None specified</p>
                  ) : (
                    <div className="flex flex-wrap items-center gap-1.5 font-mono text-[11px] text-[#18120F]">
                      {selectedItem.data.toolsAvailable.map((tool, idx) => (
                        <React.Fragment key={tool}>
                          <span>{tool}</span>
                          {idx < selectedItem.data.toolsAvailable.length - 1 && (
                            <span className="text-[#6B5A4E]" aria-hidden="true">
                              ·
                            </span>
                          )}
                        </React.Fragment>
                      ))}
                    </div>
                  )}
                </div>

                {selectedItem.data.contextLimit && (
                  <div className="pt-2 border-t border-[#C5CBBF] space-y-1.5">
                    {(() => {
                      const ctx = formatContextUsage(selectedItem.data.contextLimit);
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

                {selectedItem.data.checkpoints.length > 0 && (
                  <div className="pt-2 border-t border-[#C5CBBF] space-y-2">
                    <h3 className="font-mono text-[11px] uppercase tracking-wider text-[#6B5A4E]">
                      Checkpoints ({selectedItem.data.checkpoints.length})
                    </h3>
                    <div className="space-y-1.5">
                      {selectedItem.data.checkpoints.map((cp) => (
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
