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
  Box,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Cpu,
  Database,
  GitBranch,
  Loader2,
  Maximize2,
  Orbit,
  Pin,
  RotateCcw,
  Server,
  Shield,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import type {
  SubstrateSubsystem,
  SubstrateSystem,
  SubstrateSystemEdge,
  SubstrateUniverse,
  SystemsSubstrateResponse,
} from '../types/substrate';
import { buildSystemsGraph } from '../utils/graphData';
import { useFloatyForceLayout } from '../hooks/useFloatyForceLayout';
import { IconButton } from './IconButton';
import { NodeDetailProvider, useNodeDetail } from '../context/NodeDetailContext';

interface SystemsGraphViewProps {
  refreshTick?: number;
  onLoadingChange?: (loading: boolean) => void;
}

type SystemNodeData = SubstrateSystem & { expanded?: boolean };
type SubsystemNodeData = SubstrateSubsystem & { systemName: string };

type SelectedSystemItem =
  | { kind: 'system'; data: SubstrateSystem }
  | { kind: 'subsystem'; data: SubsystemNodeData };

function SystemIcon({ type, selected }: { type: string; selected?: boolean }) {
  const cls = selected ? 'w-4 h-4 text-[#E04819]' : 'w-4 h-4 text-[#DF6B3B]';
  switch (type) {
    case 'database':
      return <Database className={cls} />;
    case 'repository':
      return <GitBranch className={cls} />;
    case 'workspace':
      return <Shield className={cls} />;
    case 'service':
      return <Server className={cls} />;
    default:
      return <Cpu className={cls} />;
  }
}

function BidirectionalHandles() {
  return (
    <>
      <Handle
        id="t-top"
        type="target"
        position={Position.Top}
        className="!w-2.5 !h-2.5 !bg-[#C83214] !border !border-[#140D0B] !rounded-none"
      />
      <Handle
        id="s-top"
        type="source"
        position={Position.Top}
        className="!w-2.5 !h-2.5 !opacity-0 !pointer-events-none"
      />
      <Handle
        id="t-left"
        type="target"
        position={Position.Left}
        className="!w-2.5 !h-2.5 !bg-[#8C7263] !border !border-[#140D0B] !rounded-none"
      />
      <Handle
        id="s-left"
        type="source"
        position={Position.Left}
        className="!w-2.5 !h-2.5 !opacity-0 !pointer-events-none"
      />
      <Handle
        id="s-bottom"
        type="source"
        position={Position.Bottom}
        className="!w-2.5 !h-2.5 !bg-[#C83214] !border !border-[#140D0B] !rounded-none"
      />
      <Handle
        id="t-bottom"
        type="target"
        position={Position.Bottom}
        className="!w-2.5 !h-2.5 !opacity-0 !pointer-events-none"
      />
      <Handle
        id="s-right"
        type="source"
        position={Position.Right}
        className="!w-2.5 !h-2.5 !bg-[#8C7263] !border !border-[#140D0B] !rounded-none"
      />
      <Handle
        id="t-right"
        type="target"
        position={Position.Right}
        className="!w-2.5 !h-2.5 !opacity-0 !pointer-events-none"
      />
    </>
  );
}

function SystemNode({ data, selected }: NodeProps) {
  const sys = data as unknown as SystemNodeData;
  const isActive = sys.status === 'active';
  const isContainerExpanded = Boolean(sys.expanded);
  const { isExpanded, isPinned, toggleExpand, togglePin } = useNodeDetail(sys.id);

  if (isContainerExpanded) {
    return (
      <div
        data-node-id={sys.id}
        className={`w-full h-full rounded-sm border transition-colors duration-150 flex flex-col ${
          selected
            ? 'bg-[#18100E]/95 text-[#F7F3EC] border-[#E04819] ring-1 ring-[#E04819]'
            : 'bg-[#160F0D]/95 text-[#F2EBE1] border-[#C83214]/75 hover:border-[#E04819]'
        }`}
      >
        <BidirectionalHandles />
        <div className="px-3.5 py-2.5 bg-[#241814] border-b border-[#3F2E27] flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <SystemIcon type={sys.systemType} selected={selected} />
            <h3 className="font-display text-sm font-semibold text-[#F7F3EC] truncate">
              {sys.name}
            </h3>
          </div>
          <span className="inline-flex items-center gap-1 font-mono text-[10px] text-[#DFE4D8] shrink-0">
            <ChevronDown className="w-3 h-3 text-[#E04819]" />
            {sys.subsystems.length} sub
          </span>
        </div>
        <div className="flex-1" />
      </div>
    );
  }

  return (
    <div
      data-node-id={sys.id}
      data-expanded-node={isExpanded}
      className={`w-full h-full rounded-sm border transition-colors duration-150 relative ${
        isExpanded
          ? 'bg-[#261914] text-[#F7F3EC] border-[#E04819] ring-1 ring-[#E04819] z-40'
          : selected
          ? 'bg-[#2C1E19] text-[#F7F3EC] border-[#E04819] ring-1 ring-[#E04819]'
          : 'bg-[#211613] text-[#F2EBE1] border-[#4A362D] hover:border-[#8C7263]'
      }`}
    >
      <BidirectionalHandles />

      <div className="flex items-center justify-between gap-2.5 px-3.5 h-full">
        <div className="flex items-center gap-2.5 min-w-0">
          <SystemIcon type={sys.systemType} selected={selected} />
          <span className="font-display text-sm font-semibold leading-tight text-[#F7F3EC] truncate">
            {sys.name}
          </span>
        </div>
        <button
          type="button"
          aria-label={`Expand details for ${sys.name}`}
          onClick={(e) => {
            e.stopPropagation();
            toggleExpand();
          }}
          className="nodrag nopan p-1 rounded-xs text-[#B9AA9D] hover:text-[#F7F3EC] hover:bg-[#382821] transition-colors shrink-0 cursor-pointer"
        >
          <ChevronDown className="w-3.5 h-3.5 pointer-events-none" />
        </button>
      </div>

      {isExpanded && (
        <div className="nodrag nopan absolute top-0 left-0 w-full z-50 rounded-sm border border-[#C83214] bg-[#211613] shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-100">
          <div className="flex items-center justify-between gap-2 px-3.5 py-2.5 bg-[#2A1B16] border-b border-[#433027]">
            <div className="flex items-center gap-2 min-w-0">
              <SystemIcon type={sys.systemType} selected={selected} />
              <span className="font-display text-sm font-semibold truncate text-[#F7F3EC]">
                {sys.name}
              </span>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <button
                type="button"
                aria-label={
                  isPinned
                    ? `Unpin ${sys.name} (auto-minimises on outside click)`
                    : `Pin ${sys.name} (stays open on outside click)`
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
                aria-label={`Minimise ${sys.name}`}
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

          <div className="p-3.5 space-y-2.5 text-xs">
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono text-[11px] text-[#B9AA9D] truncate">
                {sys.systemKey}
              </span>
              <span
                className={`font-mono text-[10px] tracking-wider uppercase shrink-0 ${
                  isActive ? 'text-[#6CC48E]' : 'text-[#E09F3E]'
                }`}
              >
                {sys.status}
              </span>
            </div>

            {sys.universeName && (
              <div className="font-mono text-[10px] text-[#DF6B3B] truncate">
                Universe: {sys.universeName}
              </div>
            )}

            <p className="text-xs leading-relaxed text-[#C8B9AC]">
              {sys.description || 'No description recorded.'}
            </p>

            <div className="pt-2 border-t border-[#3D2B24] flex items-center justify-between text-[11px] font-mono text-[#A89688]">
              <span>
                v{sys.contextVersion} · {sys.memoriesCount} mem · {sys.constraintsCount} cstr
              </span>
              <span className="inline-flex items-center gap-1 text-[#DFE4D8]">
                <ChevronRight className="w-3 h-3 text-[#E04819]" />
                {sys.subsystems.length} sub
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function SubsystemNode({ data, selected }: NodeProps) {
  const sub = data as unknown as SubsystemNodeData;
  const isActive = sub.status === 'active';
  const { isExpanded, isPinned, toggleExpand, togglePin } = useNodeDetail(sub.id);

  return (
    <div
      data-node-id={sub.id}
      data-expanded-node={isExpanded}
      className={`w-full h-full rounded-sm border transition-colors duration-150 relative ${
        isExpanded
          ? 'bg-[#2E1E19] text-[#F7F3EC] border-[#DF6B3B] ring-1 ring-[#DF6B3B] z-40'
          : selected
          ? 'bg-[#2F211C] text-[#F7F3EC] border-[#E04819] ring-1 ring-[#E04819]'
          : 'bg-[#241814] text-[#F2EBE1] border-[#594238] hover:border-[#DF6B3B]'
      }`}
    >
      <BidirectionalHandles />

      <div className="flex items-center justify-between gap-2 px-3 h-full">
        <div className="flex items-center gap-2 min-w-0">
          <Box className="w-3.5 h-3.5 text-[#DF6B3B] shrink-0" />
          <span className="font-display text-xs font-semibold text-[#F7F3EC] truncate">
            {sub.name}
          </span>
        </div>
        <button
          type="button"
          aria-label={`Expand details for ${sub.name}`}
          onClick={(e) => {
            e.stopPropagation();
            toggleExpand();
          }}
          className="nodrag nopan p-1 rounded-xs text-[#B9AA9D] hover:text-[#F7F3EC] hover:bg-[#382821] transition-colors shrink-0 cursor-pointer"
        >
          <ChevronDown className="w-3 h-3 pointer-events-none" />
        </button>
      </div>

      {isExpanded && (
        <div className="nodrag nopan absolute top-0 left-0 w-full z-50 rounded-sm border border-[#DF6B3B] bg-[#241814] shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-100">
          <div className="flex items-center justify-between gap-2 px-3 py-2 bg-[#2D1C16] border-b border-[#4A342B]">
            <div className="flex items-center gap-1.5 min-w-0">
              <Box className="w-3 h-3 text-[#DF6B3B] shrink-0 pointer-events-none" />
              <span className="font-display text-xs font-semibold truncate text-[#F7F3EC]">
                {sub.name}
              </span>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <button
                type="button"
                aria-label={
                  isPinned
                    ? `Unpin ${sub.name} (auto-minimises on outside click)`
                    : `Pin ${sub.name} (stays open on outside click)`
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
                <Pin className={`w-3 h-3 pointer-events-none ${isPinned ? 'fill-current' : ''}`} />
              </button>
              <button
                type="button"
                aria-label={`Minimise ${sub.name}`}
                onClick={(e) => {
                  e.stopPropagation();
                  toggleExpand();
                }}
                className="nodrag nopan p-1 rounded-xs text-[#B9AA9D] hover:text-[#F7F3EC] hover:bg-[#382821] transition-colors cursor-pointer"
              >
                <ChevronUp className="w-3 h-3 pointer-events-none" />
              </button>
            </div>
          </div>

          <div className="p-3 space-y-2 text-xs">
            <div className="flex items-center justify-between gap-2 font-mono text-[10px]">
              <span className="text-[#DF6B3B]">{sub.readableKey}</span>
              <span className={isActive ? 'text-[#6CC48E] uppercase' : 'text-[#E09F3E] uppercase'}>
                {sub.status}
              </span>
            </div>
            <p className="text-[11px] text-[#C8B9AC] leading-relaxed">
              {sub.description || 'No description recorded.'}
            </p>
            <div className="bg-[#150E0B] border border-[#382821] px-2 py-1 font-mono text-[10px] text-[#DFE4D8] break-all">
              {sub.contract || '{}'}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const nodeTypes = {
  systemNode: SystemNode,
  subsystemNode: SubsystemNode,
};

function SystemsGraphCanvas({ refreshTick = 0, onLoadingChange }: SystemsGraphViewProps) {
  const [universes, setUniverses] = useState<SubstrateUniverse[]>([]);
  const [systems, setSystems] = useState<SubstrateSystem[]>([]);
  const [rawEdges, setRawEdges] = useState<SubstrateSystemEdge[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [showWormholes, setShowWormholes] = useState(true);
  const [expandedSystemIds, setExpandedSystemIds] = useState<string[]>([]);
  const [selectedItem, setSelectedItem] = useState<SelectedSystemItem | null>(null);
  const { zoomIn, zoomOut, fitView } = useReactFlow();

  const fetchSystems = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    onLoadingChange?.(true);
    setError(null);
    try {
      const res = await fetch('/api/substrate/systems', { signal });
      const payload = (await res.json()) as Partial<SystemsSubstrateResponse> & { error?: string };
      if (!res.ok) {
        throw new Error(payload.error || `Failed to load systems (HTTP ${res.status})`);
      }
      setUniverses(Array.isArray(payload.universes) ? payload.universes : []);
      setSystems(Array.isArray(payload.systems) ? payload.systems : []);
      setRawEdges(Array.isArray(payload.edges) ? payload.edges : []);
    } catch (err) {
      if ((err as { name?: string })?.name === 'AbortError') return;
      setError(err instanceof Error ? err.message : 'Unable to load systems from Supabase.');
    } finally {
      if (!signal?.aborted) {
        setLoading(false);
        onLoadingChange?.(false);
      }
    }
  }, [onLoadingChange]);

  useEffect(() => {
    const controller = new AbortController();
    void fetchSystems(controller.signal);
    return () => controller.abort();
  }, [fetchSystems, refreshTick]);

  const initialGraph = useMemo(
    () =>
      buildSystemsGraph({
        systems,
        edges: rawEdges,
        showWormholes,
        expandedSystemIds,
      }),
    [systems, rawEdges, showWormholes, expandedSystemIds]
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
    amplitude: 4.2,
  });

  useEffect(() => {
    const anchoredNodes = applySavedAnchors(initialGraph.nodes);
    setNodes(anchoredNodes);
    setEdges(initialGraph.edges);
    resetBodies(anchoredNodes, false);
    const timer = window.setTimeout(() => fitView({ padding: 0.22, duration: 200 }), 140);
    return () => window.clearTimeout(timer);
  }, [initialGraph, setNodes, setEdges, applySavedAnchors, resetBodies, fitView]);

  const handleReset = useCallback(() => {
    setExpandedSystemIds([]);
    setSelectedItem(null);
    const fresh = buildSystemsGraph({
      systems,
      edges: rawEdges,
      showWormholes,
      expandedSystemIds: [],
    });
    setNodes(fresh.nodes);
    setEdges(fresh.edges);
    resetBodies(fresh.nodes, true);
    setTimeout(() => fitView({ padding: 0.22, duration: 220 }), 120);
  }, [systems, rawEdges, showWormholes, setNodes, setEdges, resetBodies, fitView]);

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
      if (node.type === 'systemNode') {
        setSelectedItem({ kind: 'system', data: node.data as unknown as SubstrateSystem });
      } else if (node.type === 'subsystemNode') {
        setSelectedItem({
          kind: 'subsystem',
          data: node.data as unknown as SubsystemNodeData,
        });
      }
    }, 210);
  }, []);

  const handleNodeDoubleClick = useCallback((_: React.MouseEvent, node: Node) => {
    if (clickTimerRef.current !== null) {
      window.clearTimeout(clickTimerRef.current);
      clickTimerRef.current = null;
    }
    if (node.type !== 'systemNode') return;
    setExpandedSystemIds((prev) =>
      prev.includes(node.id) ? prev.filter((id) => id !== node.id) : [...prev, node.id]
    );
  }, []);

  const [isBreadcrumbPinned, setIsBreadcrumbPinned] = useState(false);

  // Derive active system & subsystem for breadcrumbs
  const activeSubsystem = useMemo(() => {
    if (selectedItem?.kind === 'subsystem') return selectedItem.data;
    return null;
  }, [selectedItem]);

  const activeSystem = useMemo(() => {
    if (selectedItem?.kind === 'system') return selectedItem.data;
    if (activeSubsystem) {
      return (
        systems.find(
          (s) =>
            s.name === activeSubsystem.systemName ||
            s.subsystems.some((sub) => sub.id === activeSubsystem.id)
        ) || null
      );
    }
    if (expandedSystemIds.length > 0) {
      const lastId = expandedSystemIds[expandedSystemIds.length - 1];
      return systems.find((s) => s.id === lastId) || null;
    }
    return null;
  }, [selectedItem, activeSubsystem, expandedSystemIds, systems]);

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
        label: 'Systems',
        icon: Cpu,
        isLeaf: !activeSystem,
        onClick: () => {
          setExpandedSystemIds([]);
          setSelectedItem(null);
          fitView({ padding: 0.18, duration: 220 });
        },
      },
    ];

    if (activeSystem) {
      crumbs.push({
        id: activeSystem.id,
        label: activeSystem.name,
        isLeaf: !activeSubsystem,
        onClick: () => {
          setSelectedItem({ kind: 'system', data: activeSystem });
          fitView({ nodes: [{ id: activeSystem.id }], duration: 220, maxZoom: 1.1 });
        },
      });
    }

    if (activeSubsystem) {
      crumbs.push({
        id: activeSubsystem.id,
        label: activeSubsystem.name,
        isLeaf: true,
        onClick: () => {
          setSelectedItem({ kind: 'subsystem', data: activeSubsystem });
        },
      });
    }

    return crumbs;
  }, [activeSystem, activeSubsystem, fitView]);

  const handleBack = useCallback(() => {
    if (activeSubsystem && activeSystem) {
      setSelectedItem({ kind: 'system', data: activeSystem });
      fitView({ nodes: [{ id: activeSystem.id }], duration: 220, maxZoom: 1.1 });
    } else if (activeSystem) {
      setExpandedSystemIds((prev) => prev.filter((id) => id !== activeSystem.id));
      setSelectedItem(null);
      fitView({ padding: 0.18, duration: 220 });
    }
  }, [activeSubsystem, activeSystem, fitView]);

  return (
    <div className="flex flex-col w-full h-[calc(100vh-112px)] min-h-[680px] border border-[#3B2A23] bg-[#140D0B] overflow-hidden">
      {/* Dedicated Top Canvas Control Bar: Breadcrumbs on Left, Zoom/Controls on Right */}
      <div className="h-14 shrink-0 px-4 border-b border-[#382821] bg-[#18100D] flex items-center justify-between gap-4 z-20">
        {/* Left: Breadcrumbs UI showing nesting path and go-back / pin actions */}
        <nav
          aria-label="Systems nesting hierarchy"
          className="flex items-center gap-1.5 min-w-0 max-w-[70%] overflow-x-auto py-1"
        >
          {breadcrumbs.length > 1 && (
            <button
              type="button"
              onClick={handleBack}
              aria-label="Go back one nesting level"
              title="Go back"
              className="p-1.5 rounded-xs border border-[#3F2E27] bg-[#1F1512] text-[#D8CFC2] hover:text-[#F7F3EC] hover:border-[#E04819] transition-colors cursor-pointer mr-0.5 shrink-0"
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
                      {Icon && <Icon className="w-3.5 h-3.5 text-[#E04819] shrink-0" />}
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
                  ? 'bg-[#C83214] text-[#F7F3EC] border-[#E04819]'
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
          <IconButton label="Fit Systems Graph" onClick={() => fitView({ padding: 0.18, duration: 220 })}>
            <Maximize2 className="w-4 h-4" />
          </IconButton>
          <div className="w-px h-6 bg-[#3D2B24] mx-1" />
          <IconButton
            label={showWormholes ? 'Hide System Wormholes' : 'Show System Wormholes'}
            active={showWormholes}
            variant="accent"
            onClick={() => setShowWormholes((v) => !v)}
          >
            <Orbit className="w-4 h-4" />
          </IconButton>
          <IconButton label="Reset & Collapse Systems" onClick={handleReset}>
            <RotateCcw className="w-4 h-4" />
          </IconButton>
        </div>
      </div>

      <div className="relative flex-1 hayate-contour-bg">
        <div className="absolute inset-0 w-full h-full" data-testid="systems-react-flow">
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
            minZoom={0.18}
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
                n.type === 'subsystemNode'
                  ? '#DF6B3B'
                  : expandedSystemIds.includes(n.id)
                  ? '#C83214'
                  : '#4A362D'
              }
              maskColor="rgba(20, 13, 11, 0.72)"
            />
          </ReactFlow>
        </div>

        {/* Live Status Overlay for Loading / Error / Empty */}
        {loading && systems.length === 0 && (
          <div className="absolute inset-0 z-20 flex items-center justify-center bg-[#140D0B]/75 backdrop-blur-[1px]">
            <div className="border border-[#433129] bg-[#1D1411] px-6 py-4 rounded-sm flex items-center gap-3 text-xs font-mono text-[#DFE4D8]">
              <Loader2 className="w-4 h-4 animate-spin text-[#E04819]" />
              <span>Loading systems from Supabase ledger...</span>
            </div>
          </div>
        )}

        {error && (
          <div className="absolute top-4 left-4 right-4 z-30 flex justify-center pointer-events-none">
            <div
              role="alert"
              className="pointer-events-auto max-w-lg w-full border border-[#C83214] bg-[#241310] px-4 py-3 rounded-sm flex items-center justify-between gap-3 text-xs text-[#F7F3EC] shadow-xl"
            >
              <div className="flex items-start gap-2.5 min-w-0">
                <AlertTriangle className="w-4 h-4 text-[#E04819] shrink-0 mt-0.5" />
                <span className="font-mono break-words">{error}</span>
              </div>
              <button
                type="button"
                onClick={() => void fetchSystems()}
                className="px-2.5 py-1 text-[11px] font-mono bg-[#C83214] hover:bg-[#E04819] text-[#F7F3EC] rounded-xs shrink-0 cursor-pointer"
              >
                Retry
              </button>
            </div>
          </div>
        )}

        {!loading && !error && systems.length === 0 && (
          <div className="absolute inset-0 z-20 flex items-center justify-center pointer-events-none">
            <div className="pointer-events-auto border border-[#433129] bg-[#1D1411] px-6 py-5 rounded-sm text-center space-y-2 max-w-md">
              <div className="font-display text-base font-semibold text-[#F7F3EC]">
                No Active Systems Recorded
              </div>
              <p className="text-xs text-[#B9AA9D]">
                The connected Supabase ledger returned zero active rows in <span className="font-mono text-[#DFE4D8]">public.systems</span>.
              </p>
            </div>
          </div>
        )}

        {/* Slide-over Detail Drawer */}
        {selectedItem && (
          <aside
            aria-label="System details"
            className="absolute top-4 right-4 bottom-4 w-full max-w-sm z-30 bg-[#DFE4D8] text-[#18120F] border border-[#8C7263] shadow-2xl flex flex-col overflow-hidden rounded-sm"
          >
            <div className="px-5 py-4 border-b border-[#C5CBBF] flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="font-mono text-[11px] text-[#6B5A4E] truncate">
                  {selectedItem.kind === 'system'
                    ? `${selectedItem.data.systemKey} · ${selectedItem.data.systemType}`
                    : `${selectedItem.data.readableKey} · ${selectedItem.data.subsystemType}`}
                </div>
                <h2 className="font-display text-lg font-bold tracking-tight text-[#18120F] mt-0.5">
                  {selectedItem.data.name}
                </h2>
              </div>
              <IconButton
                label="Close System Details"
                tooltipSide="left"
                className="!bg-[#18120F] !text-[#DFE4D8] !border-[#18120F] hover:!bg-[#C83214] hover:!border-[#C83214]"
                onClick={() => setSelectedItem(null)}
              >
                <X className="w-4 h-4" />
              </IconButton>
            </div>

            {selectedItem.kind === 'system' ? (
              <div className="flex-1 overflow-y-auto p-5 space-y-5 text-xs">
                {selectedItem.data.universeName && (
                  <div className="font-mono text-[11px] text-[#5D5046] border-b border-[#C5CBBF] pb-2">
                    Universe: <span className="font-semibold text-[#18120F]">{selectedItem.data.universeName}</span>
                  </div>
                )}

                <div>
                  <h3 className="font-mono text-[11px] uppercase tracking-wider text-[#6B5A4E] mb-1.5">
                    Substrate Role
                  </h3>
                  <p className="text-sm text-[#2C221D] leading-relaxed">
                    {selectedItem.data.description || 'No description recorded.'}
                  </p>
                </div>

                <div className="grid grid-cols-4 gap-2 border-y border-[#C5CBBF] py-3 font-mono">
                  <div>
                    <div className="text-[10px] text-[#6B5A4E]">Version</div>
                    <div className="text-sm font-semibold">v{selectedItem.data.contextVersion}</div>
                  </div>
                  <div>
                    <div className="text-[10px] text-[#6B5A4E]">Subsys</div>
                    <div className="text-sm font-semibold">{selectedItem.data.subsystems.length}</div>
                  </div>
                  <div>
                    <div className="text-[10px] text-[#6B5A4E]">Memories</div>
                    <div className="text-sm font-semibold">{selectedItem.data.memoriesCount}</div>
                  </div>
                  <div>
                    <div className="text-[10px] text-[#6B5A4E]">Constraints</div>
                    <div className="text-sm font-semibold">{selectedItem.data.constraintsCount}</div>
                  </div>
                </div>

                {Object.keys(selectedItem.data.parameters || {}).length > 0 && (
                  <div>
                    <h3 className="font-mono text-[11px] uppercase tracking-wider text-[#6B5A4E] mb-2">
                      Parameters
                    </h3>
                    <pre className="bg-[#D2D8CA] border border-[#B6BEAE] p-2.5 font-mono text-[11px] text-[#18120F] rounded-xs overflow-x-auto whitespace-pre-wrap break-all">
                      {JSON.stringify(selectedItem.data.parameters, null, 2)}
                    </pre>
                  </div>
                )}

                <div>
                  <h3 className="font-mono text-[11px] uppercase tracking-wider text-[#6B5A4E] mb-2">
                    Nested Subsystems
                  </h3>
                  {selectedItem.data.subsystems.length === 0 ? (
                    <p className="font-mono text-[11px] text-[#6B5A4E]">
                      No nested subsystems recorded.
                    </p>
                  ) : (
                    <div className="space-y-2">
                      {selectedItem.data.subsystems.map((sub) => (
                        <div
                          key={sub.id}
                          className="bg-[#D2D8CA] border border-[#B6BEAE] p-2.5 rounded-xs space-y-1"
                        >
                          <div className="flex items-center justify-between font-mono text-[10px]">
                            <span className="text-[#C83214] font-semibold">{sub.readableKey}</span>
                            <span className="uppercase text-[#5A4B42]">{sub.status}</span>
                          </div>
                          <div className="font-semibold text-[#18120F]">{sub.name}</div>
                          <div className="font-mono text-[10px] text-[#4C4039] break-all">
                            {sub.contract}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div>
                  <h3 className="font-mono text-[11px] uppercase tracking-wider text-[#6B5A4E] mb-2">
                    System Functions
                  </h3>
                  {selectedItem.data.functions.length === 0 ? (
                    <p className="font-mono text-[11px] text-[#6B5A4E]">
                      No functions recorded.
                    </p>
                  ) : (
                    <div className="space-y-2.5">
                      {selectedItem.data.functions.map((fn) => (
                        <div
                          key={fn.key}
                          className="bg-[#D2D8CA] border border-[#B6BEAE] p-3 rounded-xs space-y-1"
                        >
                          <div className="font-semibold text-[#18120F]">{fn.name}</div>
                          <div className="font-mono text-[11px] text-[#C83214]">{fn.key}</div>
                          <div className="font-mono text-[11px] text-[#4C4039] pt-1">
                            In: {fn.inputContract}
                          </div>
                          <div className="font-mono text-[11px] text-[#4C4039]">
                            Out: {fn.outputContract}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <div className="flex-1 overflow-y-auto p-5 space-y-4 text-xs">
                <div className="font-mono text-[11px] text-[#5D5046] border-b border-[#C5CBBF] pb-2">
                  Parent System: <span className="font-semibold text-[#18120F]">{selectedItem.data.systemName}</span>
                </div>
                <div>
                  <h3 className="font-mono text-[11px] uppercase tracking-wider text-[#6B5A4E] mb-1.5">
                    Subsystem Responsibility
                  </h3>
                  <p className="text-sm text-[#2C221D] leading-relaxed">
                    {selectedItem.data.description || 'No description recorded.'}
                  </p>
                </div>
                <div>
                  <h3 className="font-mono text-[11px] uppercase tracking-wider text-[#6B5A4E] mb-1.5">
                    Interface Contract
                  </h3>
                  <pre className="bg-[#18120F] text-[#F2EBE1] p-3 font-mono text-[11px] rounded-xs whitespace-pre-wrap break-all">
                    {selectedItem.data.contract || '{}'}
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

export function SystemsGraphView(props: SystemsGraphViewProps) {
  return (
    <ReactFlowProvider>
      <NodeDetailProvider>
        <SystemsGraphCanvas {...props} />
      </NodeDetailProvider>
    </ReactFlowProvider>
  );
}
