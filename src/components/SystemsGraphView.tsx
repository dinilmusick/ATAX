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
  Box,
  ChevronLeft,
  ChevronRight,
  Cpu,
  Database,
  GitBranch,
  Info,
  Loader2,
  Maximize2,
  Orbit,
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

interface SystemsGraphViewProps {
  refreshTick?: number;
  onLoadingChange?: (loading: boolean) => void;
}

type SubsystemNodeData = SubstrateSubsystem & { systemName: string };

type SelectedSystemItem =
  | { kind: 'system'; data: SubstrateSystem }
  | { kind: 'subsystem'; data: SubsystemNodeData };

function SystemIcon({ type, selected }: { type: string; selected?: boolean }) {
  const cls = selected ? 'w-4 h-4 text-[#FF9E80]' : 'w-4 h-4 text-[#E04819]';
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

function BidirectionalHandles({ accentColor = '#E04819' }: { accentColor?: string }) {
  return (
    <>
      <Handle
        id="t-top"
        type="target"
        position={Position.Top}
        style={{ backgroundColor: accentColor }}
        className="!w-2.5 !h-2.5 !border !border-[#140D0B] !rounded-none"
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
        style={{ backgroundColor: accentColor }}
        className="!w-2.5 !h-2.5 !border !border-[#140D0B] !rounded-none"
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

/**
 * SYSTEM NODE — Chamfered Octagonal Hardware Chassis (Vermilion-Copper & Iron Espresso)
 * Single click -> Details Panel; Double click -> Enter System to view its Subsystems.
 */
function SystemNode({ data, selected }: NodeProps) {
  const sys = data as unknown as SubstrateSystem;
  const isActive = sys.status === 'active';

  return (
    <div
      data-node-id={sys.id}
      className="group relative w-full h-full cursor-pointer select-none"
    >
      {/* Chamfered Octagon SVG Frame (300 x 124) */}
      <svg
        viewBox="0 0 300 124"
        className="absolute inset-0 w-full h-full pointer-events-none overflow-visible drop-shadow-[0_10px_18px_rgba(0,0,0,0.48)]"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <polygon
          points="16,2 284,2 298,16 298,108 284,122 16,122 2,108 2,16"
          fill={selected ? '#2D1610' : '#1E100D'}
          stroke={selected ? '#FF7A50' : '#E04819'}
          strokeWidth={selected ? 2.5 : 1.75}
          strokeLinejoin="miter"
          className="transition-colors duration-150 group-hover:fill-[#28140F] group-hover:stroke-[#FF6D42]"
        />
        {/* Inner hardware chassis hairline */}
        <polygon
          points="20,7 280,7 293,20 293,104 280,117 20,117 7,104 7,20"
          fill="none"
          stroke="#E04819"
          strokeOpacity={0.22}
          strokeWidth={1}
        />
      </svg>

      <BidirectionalHandles accentColor="#E04819" />

      <div className="relative z-10 w-full h-full flex flex-col justify-between px-5 py-3.5">
        <div className="flex items-center justify-between gap-2 text-[10px] font-mono">
          <span className="inline-flex items-center gap-1.5 text-[#FF9E80] font-semibold tracking-wider uppercase truncate">
            <SystemIcon type={sys.systemType} selected={selected} />
            <span>System · {sys.systemKey}</span>
          </span>
          <span
            className={`uppercase font-semibold shrink-0 ${
              isActive ? 'text-[#6EE7B7]' : 'text-[#FCD34D]'
            }`}
          >
            {sys.status}
          </span>
        </div>

        <div className="my-auto py-0.5">
          <h3 className="font-display text-sm font-bold leading-snug text-[#FDF5F0] truncate">
            {sys.name}
          </h3>
          <div className="text-[11px] font-mono text-[#C8B9AC] truncate mt-0.5">
            {sys.universeName ? `${sys.universeName} · ${sys.systemType}` : sys.systemType}
          </div>
        </div>

        <div className="pt-1.5 border-t border-[#E04819]/25 flex items-center justify-between gap-2 text-[10px] font-mono tabular-nums">
          <span className="text-[#B9AA9D]">
            v{sys.contextVersion} · {sys.memoriesCount} mem · {sys.constraintsCount} cstr
          </span>
          <span className="inline-flex items-center gap-1 font-semibold text-[#FF9E80] shrink-0">
            <span>{sys.subsystems.length} sub</span>
            <ArrowRight className="w-3 h-3 opacity-70 group-hover:translate-x-0.5 transition-transform" />
          </span>
        </div>
      </div>
    </div>
  );
}

/**
 * SUBSYSTEM NODE — D-Shaped Left-Rounded Blade (Deep Plum-Violet & Lavender)
 * Single click -> Details Panel.
 */
function SubsystemNode({ data, selected }: NodeProps) {
  const sub = data as unknown as SubsystemNodeData;
  const isActive = sub.status === 'active';

  return (
    <div
      data-node-id={sub.id}
      className={`group relative w-full h-full rounded-l-[38px] rounded-r-sm border-2 transition-all duration-150 cursor-pointer select-none shadow-lg flex items-center gap-3 px-3.5 py-2.5 ${
        selected
          ? 'bg-[#25173B] border-[#C4B5FD] ring-2 ring-[#A78BFA]/55'
          : 'bg-[#180F26] border-[#A78BFA]/80 hover:border-[#C4B5FD] hover:bg-[#201433]'
      }`}
    >
      <BidirectionalHandles accentColor="#A78BFA" />

      {/* Circular Icon Well */}
      <div className="w-11 h-11 rounded-full bg-[#2B1C42] border border-[#A78BFA]/50 flex items-center justify-center shrink-0">
        <Box className="w-4 h-4 text-[#DDD6FE]" />
      </div>

      <div className="min-w-0 flex-1 flex flex-col justify-between h-full py-0.5">
        <div className="flex items-center justify-between gap-2 text-[10px] font-mono">
          <span className="text-[#DDD6FE] font-semibold truncate uppercase tracking-wider">
            {sub.readableKey}
          </span>
          <span className={isActive ? 'text-[#6EE7B7] uppercase shrink-0' : 'text-[#FCD34D] uppercase shrink-0'}>
            {sub.status}
          </span>
        </div>

        <div className="font-display text-xs font-bold text-[#F5F3FF] truncate">
          {sub.name}
        </div>

        <div className="font-mono text-[10px] text-[#C4B5FD]/75 truncate">
          {sub.contract || sub.subsystemType}
        </div>
      </div>
    </div>
  );
}

const nodeTypes = {
  systemNode: SystemNode,
  subsystemNode: SubsystemNode,
};

function SystemsGraphCanvas({ refreshTick = 0, onLoadingChange }: SystemsGraphViewProps) {
  const [, setUniverses] = useState<SubstrateUniverse[]>([]);
  const [systems, setSystems] = useState<SubstrateSystem[]>([]);
  const [rawEdges, setRawEdges] = useState<SubstrateSystemEdge[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [showWormholes, setShowWormholes] = useState(true);
  const [focusedSystemId, setFocusedSystemId] = useState<string | null>(null);
  const [selectedItem, setSelectedItem] = useState<SelectedSystemItem | null>(null);
  const { zoomIn, zoomOut, fitView } = useReactFlow();

  const fetchSystems = useCallback(
    async (signal?: AbortSignal) => {
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
    },
    [onLoadingChange]
  );

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
        focusedSystemId,
      }),
    [systems, rawEdges, showWormholes, focusedSystemId]
  );
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

  const handleReset = useCallback(() => {
    setSelectedItem(null);
    resetBodies(initialGraph.nodes, true);
    setNodes(initialGraph.nodes);
    setEdges(initialGraph.edges);
    window.setTimeout(() => fitView({ padding: 0.22, duration: 220, maxZoom: 1.15 }), 80);
  }, [initialGraph, setNodes, setEdges, resetBodies, fitView]);

  const clickTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (clickTimerRef.current !== null) window.clearTimeout(clickTimerRef.current);
    };
  }, []);

  const enterSystem = useCallback((systemId: string) => {
    setSelectedItem(null);
    setFocusedSystemId(systemId);
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
    }, 200);
  }, []);

  const handleNodeDoubleClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      if (clickTimerRef.current !== null) {
        window.clearTimeout(clickTimerRef.current);
        clickTimerRef.current = null;
      }
      if (node.type === 'systemNode') {
        enterSystem(node.id);
      } else if (node.type === 'subsystemNode') {
        setSelectedItem({
          kind: 'subsystem',
          data: node.data as unknown as SubsystemNodeData,
        });
      }
    },
    [enterSystem]
  );

  const focusedSystem = useMemo(() => {
    if (!focusedSystemId) return null;
    return systems.find((s) => s.id === focusedSystemId) || null;
  }, [focusedSystemId, systems]);

  const breadcrumbs = useMemo(() => {
    const crumbs: Array<{
      id: string;
      label: string;
      icon?: React.ComponentType<{ className?: string }>;
      onClick?: () => void;
    }> = [
      {
        id: 'root',
        label: 'Systems',
        icon: Cpu,
        onClick: () => {
          setSelectedItem(null);
          setFocusedSystemId(null);
        },
      },
    ];

    if (focusedSystem) {
      crumbs.push({
        id: focusedSystem.id,
        label: focusedSystem.name,
      });
    }

    return crumbs;
  }, [focusedSystem]);

  const handleBack = useCallback(() => {
    setSelectedItem(null);
    setFocusedSystemId(null);
  }, []);

  const handleInspectCurrentSystem = useCallback(() => {
    if (focusedSystem) {
      setSelectedItem({ kind: 'system', data: focusedSystem });
    }
  }, [focusedSystem]);

  return (
    <div className="flex flex-col w-full h-[calc(100vh-112px)] min-h-[680px] border border-[#3B2A23] bg-[#140D0B] overflow-hidden">
      {/* Top Canvas Bar: Nested Breadcrumbs on Left, Clean Controls on Right */}
      <div className="h-14 shrink-0 px-4 border-b border-[#382821] bg-[#18100D] flex items-center justify-between gap-4 z-20">
        <nav
          aria-label="Systems nesting hierarchy"
          className="flex items-center gap-1.5 min-w-0 max-w-[68%] overflow-x-auto py-1"
        >
          {focusedSystem && (
            <button
              type="button"
              onClick={handleBack}
              aria-label="Go back to Systems"
              title="Back"
              className="inline-flex items-center gap-1 px-2 py-1 rounded-xs border border-[#3F2E27] bg-[#1F1512] text-[#D8CFC2] hover:text-[#F7F3EC] hover:border-[#E04819] transition-colors cursor-pointer mr-1 shrink-0 font-mono text-xs"
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

          {focusedSystem && (
            <IconButton
              label="View current System details"
              onClick={handleInspectCurrentSystem}
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
          {!focusedSystem && (
            <IconButton
              label={showWormholes ? 'Hide System Wormholes' : 'Show System Wormholes'}
              active={showWormholes}
              variant="accent"
              onClick={() => setShowWormholes((v) => !v)}
            >
              <Orbit className="w-4 h-4" />
            </IconButton>
          )}
          <IconButton label="Reset Node Positions" onClick={handleReset}>
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
            onPaneClick={() => setSelectedItem(null)}
            fitView
            fitViewOptions={{ padding: 0.22 }}
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
              nodeColor={(n) => (n.type === 'subsystemNode' ? '#A78BFA' : '#E04819')}
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

        {!loading && !error && focusedSystem && nodes.length === 0 && (
          <div className="absolute inset-0 z-20 flex items-center justify-center pointer-events-none">
            <div className="pointer-events-auto border border-[#433129] bg-[#1D1411] px-6 py-5 rounded-sm text-center space-y-3 max-w-md shadow-2xl">
              <div className="font-display text-base font-semibold text-[#F7F3EC]">
                No Subsystems Inside {focusedSystem.name}
              </div>
              <p className="text-xs text-[#B9AA9D]">
                This system does not have any nested subsystems recorded yet. You can inspect its
                functions and parameters in the details panel.
              </p>
              <div className="flex items-center justify-center gap-2 pt-1">
                <button
                  type="button"
                  onClick={handleBack}
                  className="px-3 py-1.5 bg-[#2A1D18] hover:bg-[#3A2821] border border-[#594238] text-[#F7F3EC] font-mono text-xs rounded-xs cursor-pointer"
                >
                  Back to Systems
                </button>
                <button
                  type="button"
                  onClick={handleInspectCurrentSystem}
                  className="px-3 py-1.5 bg-[#C83214] hover:bg-[#E04819] text-[#F7F3EC] font-mono text-xs rounded-xs cursor-pointer"
                >
                  View System Details
                </button>
              </div>
            </div>
          </div>
        )}

        {!loading && !error && !focusedSystem && systems.length === 0 && (
          <div className="absolute inset-0 z-20 flex items-center justify-center pointer-events-none">
            <div className="pointer-events-auto border border-[#433129] bg-[#1D1411] px-6 py-5 rounded-sm text-center space-y-2 max-w-md">
              <div className="font-display text-base font-semibold text-[#F7F3EC]">
                No Active Systems Recorded
              </div>
              <p className="text-xs text-[#B9AA9D]">
                The connected Supabase ledger returned zero active rows in{' '}
                <span className="font-mono text-[#DFE4D8]">public.systems</span>.
              </p>
            </div>
          </div>
        )}

        {/* Slide-over Detail Drawer (Single Click) */}
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
                    Universe:{' '}
                    <span className="font-semibold text-[#18120F]">
                      {selectedItem.data.universeName}
                    </span>
                  </div>
                )}

                {focusedSystemId !== selectedItem.data.id && (
                  <div>
                    <button
                      type="button"
                      onClick={() => enterSystem(selectedItem.data.id)}
                      className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 bg-[#C83214] hover:bg-[#E04819] text-[#F7F3EC] font-mono text-xs font-semibold rounded-xs transition-colors cursor-pointer"
                    >
                      <span>Open Subsystems Inside System</span>
                      <ArrowRight className="w-3.5 h-3.5" />
                    </button>
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

                <div className="grid grid-cols-4 gap-2 border-y border-[#C5CBBF] py-3 font-mono tabular-nums">
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
                    <p className="font-mono text-[11px] text-[#6B5A4E]">No functions recorded.</p>
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
                  Parent System:{' '}
                  <span className="font-semibold text-[#18120F]">{selectedItem.data.systemName}</span>
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
                  <pre className="bg-[#18120F] text-[#DDD6FE] p-3 font-mono text-[11px] rounded-xs whitespace-pre-wrap break-all">
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
      <SystemsGraphCanvas {...props} />
    </ReactFlowProvider>
  );
}
