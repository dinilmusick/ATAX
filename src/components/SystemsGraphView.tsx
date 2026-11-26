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
  Box,
  ChevronLeft,
  ChevronRight,
  Cpu,
  Database,
  GitBranch,
  GitMerge,
  Info,
  Loader2,
  Maximize2,
  Orbit,
  Palette,
  RotateCcw,
  Server,
  Shield,
  Split,
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
  GroupingBoxItem,
  NodeColorPreferences,
  NodeTypeKey,
  SavedNodePositionsMap,
  StickyNoteItem,
  SubstrateSubsystem,
  SubstrateSystem,
  SubstrateSystemEdge,
  SubstrateUniverse,
  SystemsSubstrateResponse,
} from '../types/substrate';
import {
  buildSystemsGraph,
  SUBSYSTEM_NODE_SIZE,
  SYSTEM_NODE_SIZE,
} from '../utils/graphData';
import { getContrastTextPalette } from '../utils/deadlineHighlight';
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

interface SystemsGraphViewProps {
  refreshTick?: number;
  onLoadingChange?: (loading: boolean) => void;
}

type SubsystemNodeData = SubstrateSubsystem & {
  systemName: string;
  customBodyColor?: string;
};

type EnrichedSystemNodeData = SubstrateSystem & {
  customBodyColor?: string;
};

type SelectedSystemItem =
  | { kind: 'system'; data: SubstrateSystem; isCustom?: boolean }
  | { kind: 'subsystem'; data: SubsystemNodeData; isCustom?: boolean }
  | { kind: 'branching'; data: BranchingNodeItem }
  | { kind: 'edge'; data: CustomEdgeItem };

function SystemIcon({
  type,
  accentColor,
}: {
  type: string;
  accentColor: string;
}) {
  const style = { color: accentColor };
  switch (type) {
    case 'database':
      return <Database className="w-4 h-4 shrink-0" style={style} />;
    case 'repository':
      return <GitBranch className="w-4 h-4 shrink-0" style={style} />;
    case 'workspace':
      return <Shield className="w-4 h-4 shrink-0" style={style} />;
    case 'service':
      return <Server className="w-4 h-4 shrink-0" style={style} />;
    default:
      return <Cpu className="w-4 h-4 shrink-0" style={style} />;
  }
}

function BidirectionalHandles({ accentColor = '#E04819' }: { accentColor?: string }) {
  return (
    <>
      {/* Silent fallback anchor IDs for pre-existing substrate directional edges */}
      <Handle
        id="s-top"
        type="source"
        position={Position.Top}
        style={{ zIndex: 0 }}
        className="!w-2 !h-2 !opacity-0 !pointer-events-none"
      />
      <Handle
        id="s-left"
        type="source"
        position={Position.Left}
        style={{ zIndex: 0 }}
        className="!w-2 !h-2 !opacity-0 !pointer-events-none"
      />
      <Handle
        id="t-bottom"
        type="target"
        position={Position.Bottom}
        style={{ zIndex: 0 }}
        className="!w-2 !h-2 !opacity-0 !pointer-events-none"
      />
      <Handle
        id="t-right"
        type="target"
        position={Position.Right}
        style={{ zIndex: 0 }}
        className="!w-2 !h-2 !opacity-0 !pointer-events-none"
      />

      {/* Primary interactive handles on all 4 sides (work from any side in ConnectionMode.Loose) */}
      <Handle
        id="t-top"
        type="target"
        position={Position.Top}
        style={{ backgroundColor: accentColor, zIndex: 10 }}
        className="!w-3.5 !h-3.5 !border-2 !border-[#140D0B] !rounded-full"
      />
      <Handle
        id="t-left"
        type="target"
        position={Position.Left}
        style={{ backgroundColor: accentColor, zIndex: 10 }}
        className="!w-3.5 !h-3.5 !border-2 !border-[#140D0B] !rounded-full"
      />
      <Handle
        id="s-bottom"
        type="source"
        position={Position.Bottom}
        style={{ backgroundColor: accentColor, zIndex: 10 }}
        className="!w-3.5 !h-3.5 !border-2 !border-[#140D0B] !rounded-full"
      />
      <Handle
        id="s-right"
        type="source"
        position={Position.Right}
        style={{ backgroundColor: accentColor, zIndex: 10 }}
        className="!w-3.5 !h-3.5 !border-2 !border-[#140D0B] !rounded-full"
      />
    </>
  );
}

/**
 * SYSTEM NODE — Chamfered Octagonal Hardware Chassis (300 x 124)
 */
const SystemNode = React.memo(function SystemNode({ data, selected }: NodeProps) {
  const sys = data as unknown as EnrichedSystemNodeData;
  const fill = sys.customBodyColor || DEFAULT_NODE_BODY_COLORS.system;
  const palette = getContrastTextPalette(fill);
  const stroke = selected ? '#FF9E80' : '#E04819';
  const isActive = sys.status === 'active';

  return (
    <div
      data-node-id={sys.id}
      data-node-shape="system-octagon"
      className="group relative w-full h-full cursor-grab active:cursor-grabbing select-none"
    >
      <svg
        viewBox="0 0 300 124"
        className="absolute inset-0 w-full h-full pointer-events-none overflow-visible"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        {selected && (
          <polygon
            points="16,2 284,2 298,16 298,108 284,122 16,122 2,108 2,16"
            fill="none"
            stroke={stroke}
            strokeOpacity={0.32}
            strokeWidth={6}
          />
        )}
        <polygon
          points="16,2 284,2 298,16 298,108 284,122 16,122 2,108 2,16"
          fill={fill}
          stroke={stroke}
          strokeWidth={selected ? 2.5 : 1.75}
          strokeLinejoin="miter"
        />
        <polygon
          points="20,7 280,7 293,20 293,104 280,117 20,117 7,104 7,20"
          fill="none"
          stroke={stroke}
          strokeOpacity={0.25}
          strokeWidth={1}
        />
      </svg>

      <BidirectionalHandles accentColor={stroke} />

      <div className="relative z-10 w-full h-full flex flex-col justify-between px-5 py-3.5">
        <div className="flex items-center justify-between gap-2 text-[10px] font-mono">
          <span
            className="inline-flex items-center gap-1.5 font-semibold tracking-wider uppercase truncate"
            style={{ color: palette.bodyColor }}
          >
            <SystemIcon type={sys.systemType} accentColor={stroke} />
            <span>System · {sys.systemKey}</span>
          </span>
          <span
            className="uppercase font-semibold shrink-0"
            style={{
              color: isActive
                ? palette.isLight
                  ? '#15803D'
                  : '#6EE7B7'
                : palette.isLight
                ? '#B45309'
                : '#FCD34D',
            }}
          >
            {sys.status}
          </span>
        </div>

        <div className="my-auto py-0.5">
          <h3
            className="font-display text-sm font-bold leading-snug truncate"
            style={{ color: palette.titleColor }}
          >
            {sys.name}
          </h3>
          <div
            className="text-[11px] font-mono truncate mt-0.5"
            style={{ color: palette.mutedColor }}
          >
            {sys.universeName ? `${sys.universeName} · ${sys.systemType}` : sys.systemType}
          </div>
        </div>

        <div
          className="pt-1.5 flex items-center justify-between gap-2 text-[10px] font-mono tabular-nums"
          style={{ borderTop: `1px solid ${palette.dividerColor}`, color: palette.mutedColor }}
        >
          <span>
            v{sys.contextVersion} · {sys.memoriesCount} mem · {sys.constraintsCount} cstr
          </span>
          <span
            className="inline-flex items-center gap-1 font-semibold shrink-0"
            style={{ color: palette.titleColor }}
          >
            <span>{sys.subsystems.length} sub</span>
            <ArrowRight className="w-3 h-3 opacity-75 group-hover:translate-x-0.5 transition-transform" />
          </span>
        </div>
      </div>
    </div>
  );
});

/**
 * SUBSYSTEM NODE — D-Shaped Pill-Left Blade (268 x 90)
 */
const SubsystemNode = React.memo(function SubsystemNode({ data, selected }: NodeProps) {
  const sub = data as unknown as SubsystemNodeData;
  const fill = sub.customBodyColor || DEFAULT_NODE_BODY_COLORS.subsystem;
  const palette = getContrastTextPalette(fill);
  const stroke = selected ? '#DDD6FE' : '#A78BFA';
  const isActive = sub.status === 'active';

  return (
    <div
      data-node-id={sub.id}
      data-node-shape="subsystem-d-blade"
      className="group relative w-full h-full cursor-grab active:cursor-grabbing select-none flex items-center gap-3 px-3.5 py-2.5"
    >
      <svg
        viewBox="0 0 268 90"
        className="absolute inset-0 w-full h-full pointer-events-none overflow-visible"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        {selected && (
          <path
            d="M 45 2 L 266 2 L 266 88 L 45 88 A 43 43 0 0 1 45 2 Z"
            fill="none"
            stroke={stroke}
            strokeOpacity={0.32}
            strokeWidth={6}
          />
        )}
        <path
          d="M 45 2 L 266 2 L 266 88 L 45 88 A 43 43 0 0 1 45 2 Z"
          fill={fill}
          stroke={stroke}
          strokeWidth={selected ? 2.5 : 1.75}
          strokeLinejoin="miter"
        />
      </svg>

      <BidirectionalHandles accentColor={stroke} />

      <div
        className="relative z-10 w-11 h-11 rounded-full flex items-center justify-center shrink-0"
        style={{
          backgroundColor: palette.trackBg,
          border: `1px solid ${stroke}`,
        }}
      >
        <Box className="w-4 h-4" style={{ color: palette.titleColor }} />
      </div>

      <div className="relative z-10 min-w-0 flex-1 flex flex-col justify-between h-full py-0.5">
        <div className="flex items-center justify-between gap-2 text-[10px] font-mono">
          <span
            className="font-semibold truncate uppercase tracking-wider"
            style={{ color: palette.bodyColor }}
          >
            {sub.readableKey}
          </span>
          <span
            className="uppercase font-semibold shrink-0"
            style={{
              color: isActive
                ? palette.isLight
                  ? '#15803D'
                  : '#6EE7B7'
                : palette.isLight
                ? '#B45309'
                : '#FCD34D',
            }}
          >
            {sub.status}
          </span>
        </div>

        <div
          className="font-display text-xs font-bold truncate"
          style={{ color: palette.titleColor }}
        >
          {sub.name}
        </div>

        <div className="font-mono text-[10px] truncate" style={{ color: palette.mutedColor }}>
          {sub.contract || sub.subsystemType}
        </div>
      </div>
    </div>
  );
});

const nodeTypes = {
  systemNode: SystemNode,
  subsystemNode: SubsystemNode,
  multiInSingleOutNode: MultiInSingleOutNode,
  singleInMultiOutNode: SingleInMultiOutNode,
  fanOutNode: FanOutNode,
  stickyNoteNode: StickyNoteNode,
  groupBoxNode: GroupBoxNode,
};

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
      color: '#E04819',
      width: 15,
      height: 15,
    },
    style: {
      stroke: '#E04819',
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

function SystemsGraphCanvas({ refreshTick = 0, onLoadingChange }: SystemsGraphViewProps) {
  const [, setUniverses] = useState<SubstrateUniverse[]>([]);
  const [rawSystems, setRawSystems] = useState<SubstrateSystem[]>([]);
  const [rawEdges, setRawEdges] = useState<SubstrateSystemEdge[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [showWormholes, setShowWormholes] = useState(true);
  const [focusedSystemId, setFocusedSystemId] = useState<string | null>(null);
  const [selectedItem, setSelectedItem] = useState<SelectedSystemItem | null>(null);
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
  const [appearanceOpen, setAppearanceOpen] = useState(false);

  const { zoomIn, zoomOut, fitView, screenToFlowPosition } = useReactFlow();
  const canvasWrapperRef = useRef<HTMLDivElement | null>(null);

  const scopeKey = useMemo(
    () => (focusedSystemId ? `systems:system:${focusedSystemId}` : 'systems:root'),
    [focusedSystemId]
  );

  const fetchSystems = useCallback(
    async (signal?: AbortSignal) => {
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

        const res = await fetch('/api/substrate/systems', { signal });
        const payload = (await res.json()) as Partial<SystemsSubstrateResponse> & { error?: string };
        if (!res.ok) {
          throw new Error(payload.error || `Failed to load systems (HTTP ${res.status})`);
        }
        setUniverses(Array.isArray(payload.universes) ? payload.universes : []);
        setRawSystems(Array.isArray(payload.systems) ? payload.systems : []);
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

  const customDomainIds = useMemo(
    () => new Set(customDomainNodes.map((n) => n.id)),
    [customDomainNodes]
  );

  const systems = useMemo((): SubstrateSystem[] => {
    const customSubsBySys = new Map<string, SubstrateSubsystem[]>();
    for (const cn of customDomainNodes) {
      if (cn.domainKind === 'subsystem' && cn.parentId) {
        const list = customSubsBySys.get(cn.parentId) || [];
        list.push({
          id: cn.id,
          systemId: cn.parentId,
          readableKey: cn.readableKey,
          name: cn.title,
          subsystemType: cn.subtitle || 'service',
          status: cn.status || 'active',
          contract: 'custom_flow()',
          description: cn.description,
        });
        customSubsBySys.set(cn.parentId, list);
      }
    }

    const baseEnriched = rawSystems.map((sys) => ({
      ...sys,
      subsystems: [...sys.subsystems, ...(customSubsBySys.get(sys.id) || [])],
    }));

    const customSys: SubstrateSystem[] = customDomainNodes
      .filter((cn) => cn.domainKind === 'system')
      .map((cn) => ({
        id: cn.id,
        universeId: null,
        universeName: 'Custom',
        systemKey: cn.readableKey,
        name: cn.title,
        systemType: cn.subtitle || 'service',
        status: cn.status || 'active',
        description: cn.description,
        contextVersion: 1,
        parameters: {},
        functions: [],
        memoriesCount: 0,
        constraintsCount: 0,
        subsystems: customSubsBySys.get(cn.id) || [],
        position: { x: cn.x, y: cn.y },
      }));

    return [...baseEnriched, ...customSys];
  }, [rawSystems, customDomainNodes]);

  const baseSubstrateGraph = useMemo(
    () =>
      buildSystemsGraph({
        systems: rawSystems,
        edges: rawEdges,
        showWormholes,
        focusedSystemId,
      }),
    [rawSystems, rawEdges, showWormholes, focusedSystemId]
  );

  // Annotation callbacks
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
    }),
    [colorPrefs]
  );

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
        const nodeType: NodeTypeKey = node.type === 'subsystemNode' ? 'subsystem' : 'system';
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
          if (cn.domainKind === 'system') {
            const sysObj = systems.find((s) => s.id === cn.id) || {
              id: cn.id,
              universeId: null,
              universeName: 'Custom',
              systemKey: cn.readableKey,
              name: cn.title,
              systemType: cn.subtitle || 'service',
              status: cn.status,
              description: cn.description,
              contextVersion: 1,
              parameters: {},
              functions: [],
              memoriesCount: 0,
              constraintsCount: 0,
              subsystems: [],
              position: pos,
            };
            return {
              id: cn.id,
              type: 'systemNode',
              position: pos,
              width: SYSTEM_NODE_SIZE.width,
              height: SYSTEM_NODE_SIZE.height,
              style: { width: SYSTEM_NODE_SIZE.width, height: SYSTEM_NODE_SIZE.height },
              data: decorateNodeData('system', cn.id, sysObj as unknown as Record<string, unknown>),
            };
          }
          const parentSys = systems.find((s) => s.id === cn.parentId);
          const subData: SubsystemNodeData = {
            id: cn.id,
            systemId: cn.parentId || '',
            readableKey: cn.readableKey,
            name: cn.title,
            subsystemType: cn.subtitle || 'service',
            status: cn.status,
            contract: 'custom_flow()',
            description: cn.description,
            systemName: parentSys?.name || 'System',
          };
          return {
            id: cn.id,
            type: 'subsystemNode',
            position: pos,
            width: SUBSYSTEM_NODE_SIZE.width,
            height: SUBSYSTEM_NODE_SIZE.height,
            style: { width: SUBSYSTEM_NODE_SIZE.width, height: SUBSYSTEM_NODE_SIZE.height },
            data: decorateNodeData(
              'subsystem',
              cn.id,
              subData as unknown as Record<string, unknown>
            ),
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
      systems,
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

  const prevFittedScopeRef = useRef<string | null>(null);
  useEffect(() => {
    const freshNodes = buildAllScopedNodes(scopeKey);
    const freshEdges = buildAllScopedEdges(scopeKey);
    setNodes(freshNodes);
    setEdges(freshEdges);

    const fitKey = `${scopeKey}:${rawSystems.length > 0 ? 'loaded' : 'empty'}`;
    if (rawSystems.length > 0 && prevFittedScopeRef.current !== fitKey) {
      prevFittedScopeRef.current = fitKey;
      const timer = window.setTimeout(() => {
        fitView({ padding: 0.2, duration: 180, maxZoom: 1.15 });
      }, 80);
      return () => window.clearTimeout(timer);
    }
    return undefined;
  }, [baseSubstrateGraph, scopeKey, rawSystems.length]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const targetNodes = buildAllScopedNodes(scopeKey);
    setNodes((prev) => {
      const existingById = new Map(prev.map((n) => [n.id, n]));
      return targetNodes.map((fresh) => {
        const existing = existingById.get(fresh.id);
        return existing
          ? {
              ...fresh,
              position: existing.position,
              selected: existing.selected,
            }
          : fresh;
      });
    });
    setEdges(buildAllScopedEdges(scopeKey));
  }, [buildAllScopedNodes, buildAllScopedEdges, scopeKey, setNodes, setEdges]);

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

  const domainAddConfig = useMemo(() => {
    if (focusedSystemId) {
      return {
        label: 'Add Subsystem',
        kind: 'subsystem' as const,
        parentId: focusedSystemId,
        width: SUBSYSTEM_NODE_SIZE.width,
        height: SUBSYSTEM_NODE_SIZE.height,
      };
    }
    return {
      label: 'Add System',
      kind: 'system' as const,
      parentId: null,
      width: SYSTEM_NODE_SIZE.width,
      height: SYSTEM_NODE_SIZE.height,
    };
  }, [focusedSystemId]);

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

  const enterSystem = useCallback((systemId: string) => {
    setSelectedItem(null);
    setContextMenu(null);
    setFocusedSystemId(systemId);
  }, []);

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
      const sys = systems.find((s) => s.id === nodeId);
      if (sys) {
        setSelectedItem({ kind: 'system', data: sys, isCustom: customDomainIds.has(sys.id) });
        return;
      }
      for (const s of systems) {
        const sub = s.subsystems.find((x) => x.id === nodeId);
        if (sub) {
          setSelectedItem({
            kind: 'subsystem',
            data: { ...sub, systemName: s.name },
            isCustom: customDomainIds.has(sub.id),
          });
          return;
        }
      }
    },
    [branchingNodes, systems, customDomainIds]
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
      if (node.type === 'systemNode') {
        enterSystem(node.id);
      } else if (node.type === 'subsystemNode') {
        selectNodeById(node.id, node.type);
      }
    },
    [enterSystem, selectNodeById]
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

  const activeSelectedItem = useMemo((): SelectedSystemItem | null => {
    if (!selectedItem) return null;
    if (selectedItem.kind === 'branching') {
      const latest = branchingNodes.find((b) => b.id === selectedItem.data.id);
      return latest ? { kind: 'branching', data: latest } : null;
    }
    if (selectedItem.kind === 'edge') {
      const latest = customEdges.find((e) => e.id === selectedItem.data.id);
      return latest ? { kind: 'edge', data: latest } : null;
    }
    if (selectedItem.kind === 'system') {
      const latest = systems.find((s) => s.id === selectedItem.data.id);
      return latest ? { kind: 'system', data: latest, isCustom: selectedItem.isCustom } : null;
    }
    for (const s of systems) {
      const sub = s.subsystems.find((x) => x.id === selectedItem.data.id);
      if (sub) {
        return {
          kind: 'subsystem',
          data: { ...sub, systemName: s.name },
          isCustom: selectedItem.isCustom,
        };
      }
    }
    return selectedItem;
  }, [selectedItem, branchingNodes, customEdges, systems]);

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
          setContextMenu(null);
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
    setContextMenu(null);
    setFocusedSystemId(null);
  }, []);

  const handleInspectCurrentSystem = useCallback(() => {
    if (focusedSystem) {
      setSelectedItem({
        kind: 'system',
        data: focusedSystem,
        isCustom: customDomainIds.has(focusedSystem.id),
      });
    }
  }, [focusedSystem, customDomainIds]);

  const renderDrawerColorCustomizer = (nodeId: string, nodeType: NodeTypeKey) => {
    const typeDefault = colorPrefs.byType[nodeType] || DEFAULT_NODE_BODY_COLORS[nodeType];
    const currentColor = resolveNodeBodyColor(colorPrefs, nodeType, nodeId);
    const hasCustomNodeColor = Boolean(colorPrefs.byNodeId[nodeId]);

    return (
      <div className="pt-3 border-t border-[#C5CBBF] space-y-2">
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
              key={`sys-node-color-${preset.color}`}
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
              aria-label="Selected system node custom body color"
              value={currentColor}
              onChange={(e) => handleChangeNodeColor(nodeId, e.target.value)}
              className="w-6 h-5 border border-[#8C7263] rounded-xs cursor-pointer p-0 bg-transparent"
            />
          </label>
        </div>
      </div>
    );
  };

  const hasVisibleNodes = nodes.some(
    (n) => n.type !== 'stickyNoteNode' && n.type !== 'groupBoxNode'
  );

  return (
    <div className="flex flex-col w-full h-[calc(100vh-112px)] min-h-[680px] border border-[#3B2A23] bg-[#140D0B] overflow-hidden">
      {/* Top Canvas Bar: Nested Breadcrumbs on Left, Appearance & Viewport Controls on Right */}
      <div className="h-14 shrink-0 px-4 border-b border-[#382821] bg-[#18100D] flex items-center justify-between gap-4 z-20">
        <nav
          aria-label="Systems nesting hierarchy"
          className="flex items-center gap-1.5 min-w-0 max-w-[65%] overflow-x-auto py-1"
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

        <div className="flex items-center gap-1.5 shrink-0">
          <span className="hidden xl:inline-block font-mono text-[11px] text-[#8C7263] mr-1.5 whitespace-nowrap">
            Drag: move · Handles: connect · Right-click: add
          </span>
          <IconButton
            label="Node Colors"
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

      <div ref={canvasWrapperRef} className="relative flex-1 hayate-contour-bg">
        <GraphAppearancePopover
          open={appearanceOpen}
          onClose={() => setAppearanceOpen(false)}
          nodeTypes={[
            { key: 'system', label: 'System (Octagon)' },
            { key: 'subsystem', label: 'Subsystem (D-Blade)' },
            { key: 'multi_in_single_out', label: 'Multi-In Selector' },
            { key: 'single_in_multi_out', label: 'Single-In Router' },
            { key: 'fan_out', label: 'Fan-Out Node' },
          ]}
          colorPrefs={colorPrefs}
          onChangeTypeColor={handleChangeTypeColor}
          onResetColors={handleResetAllColors}
          showDeadlineLegend={false}
        />

        <div className="absolute inset-0 w-full h-full" data-testid="systems-react-flow">
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
            connectionLineStyle={{ stroke: '#E04819', strokeWidth: 2 }}
            defaultEdgeOptions={{
              type: 'smoothstep',
              markerEnd: {
                type: MarkerType.ArrowClosed,
                color: '#E04819',
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
                String(node.data?.name || node.data?.title || node.data?.readableKey || node.id);
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
              nodeColor={(n) => {
                if (n.type === 'stickyNoteNode') return String(n.data?.color || '#FEF08A');
                if (n.type === 'groupBoxNode') return 'rgba(224, 72, 25, 0.35)';
                if (n.data?.customBodyColor) return String(n.data.customBodyColor);
                if (n.type === 'multiInSingleOutNode') return '#06B6D4';
                if (n.type === 'singleInMultiOutNode') return '#F43F5E';
                if (n.type === 'fanOutNode') return '#84CC16';
                return n.type === 'subsystemNode' ? '#A78BFA' : '#E04819';
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

        {loading && systems.length === 0 && (
          <div className="absolute inset-0 z-20 flex items-center justify-center bg-[#140D0B]/75">
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

        {!loading && !error && focusedSystem && !hasVisibleNodes && (
          <div className="absolute inset-0 z-10 flex items-center justify-center pointer-events-none">
            <div className="pointer-events-auto border border-[#433129] bg-[#1D1411] px-6 py-5 rounded-sm text-center space-y-3 max-w-md shadow-2xl">
              <div className="font-display text-base font-semibold text-[#F7F3EC]">
                No Subsystems Inside {focusedSystem.name}
              </div>
              <p className="text-xs text-[#B9AA9D]">
                Right-click the canvas to add subsystems, branching nodes, sticky notes, or grouping
                boxes.
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
          <div className="absolute inset-0 z-10 flex items-center justify-center pointer-events-none">
            <div className="pointer-events-auto border border-[#433129] bg-[#1D1411] px-6 py-5 rounded-sm text-center space-y-2 max-w-md">
              <div className="font-display text-base font-semibold text-[#F7F3EC]">
                No Active Systems Recorded
              </div>
              <p className="text-xs text-[#B9AA9D]">
                Right-click anywhere on the canvas to add custom systems or branching nodes.
              </p>
            </div>
          </div>
        )}

        {/* Slide-over Detail Drawer */}
        {activeSelectedItem && (
          <aside
            aria-label="System details"
            className="absolute top-4 right-4 bottom-4 w-full max-w-sm z-30 bg-[#DFE4D8] text-[#18120F] border border-[#8C7263] shadow-2xl flex flex-col overflow-hidden rounded-sm"
          >
            <div className="px-5 py-4 border-b border-[#C5CBBF] flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="font-mono text-[11px] text-[#6B5A4E] truncate uppercase">
                  {activeSelectedItem.kind === 'system'
                    ? `${activeSelectedItem.data.systemKey} · ${activeSelectedItem.data.systemType}`
                    : activeSelectedItem.kind === 'subsystem'
                    ? `${activeSelectedItem.data.readableKey} · ${activeSelectedItem.data.subsystemType}`
                    : activeSelectedItem.kind === 'branching'
                    ? `Branching · ${activeSelectedItem.data.kind.replace(/_/g, ' ')}`
                    : 'Flow Connection'}
                </div>
                <h2 className="font-display text-lg font-bold tracking-tight text-[#18120F] mt-0.5 truncate">
                  {activeSelectedItem.kind === 'edge'
                    ? activeSelectedItem.data.label || 'Flow Edge'
                    : activeSelectedItem.kind === 'branching'
                    ? activeSelectedItem.data.title
                    : activeSelectedItem.data.name}
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

                {renderDrawerColorCustomizer(
                  activeSelectedItem.data.id,
                  activeSelectedItem.data.kind
                )}

                <button
                  type="button"
                  onClick={() => handleDeleteNode(activeSelectedItem.data.id)}
                  className="w-full inline-flex items-center justify-center gap-2 px-4 py-2 bg-[#B91C1C] hover:bg-[#991B1B] text-[#FEF2F2] font-mono text-xs font-semibold rounded-xs transition-colors cursor-pointer"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  <span>Delete Branching Node</span>
                </button>
              </div>
            )}

            {activeSelectedItem.kind === 'system' && (
              <div className="flex-1 overflow-y-auto p-5 space-y-5 text-xs">
                {activeSelectedItem.data.universeName && (
                  <div className="font-mono text-[11px] text-[#5D5046] border-b border-[#C5CBBF] pb-2">
                    Universe:{' '}
                    <span className="font-semibold text-[#18120F]">
                      {activeSelectedItem.data.universeName}
                    </span>
                  </div>
                )}

                {activeSelectedItem.isCustom && (
                  <div className="space-y-2 bg-[#D2D8CA] border border-[#B6BEAE] p-3 rounded-xs font-mono">
                    <label className="flex flex-col gap-1">
                      <span className="text-[10px] uppercase text-[#5D5046]">Name</span>
                      <input
                        type="text"
                        value={activeSelectedItem.data.name}
                        onChange={(e) =>
                          updateCustomDomainField(activeSelectedItem.data.id, {
                            title: e.target.value,
                          })
                        }
                        className="bg-[#EEF1EA] border border-[#9DA594] px-2 py-1 rounded-xs text-xs text-[#18120F]"
                      />
                    </label>
                    <label className="flex flex-col gap-1">
                      <span className="text-[10px] uppercase text-[#5D5046]">Role Description</span>
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

                {focusedSystemId !== activeSelectedItem.data.id && (
                  <div>
                    <button
                      type="button"
                      onClick={() => enterSystem(activeSelectedItem.data.id)}
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
                    {activeSelectedItem.data.description || 'No description recorded.'}
                  </p>
                </div>

                <div className="grid grid-cols-4 gap-2 border-y border-[#C5CBBF] py-3 font-mono tabular-nums">
                  <div>
                    <div className="text-[10px] text-[#6B5A4E]">Version</div>
                    <div className="text-sm font-semibold">
                      v{activeSelectedItem.data.contextVersion}
                    </div>
                  </div>
                  <div>
                    <div className="text-[10px] text-[#6B5A4E]">Subsys</div>
                    <div className="text-sm font-semibold">
                      {activeSelectedItem.data.subsystems.length}
                    </div>
                  </div>
                  <div>
                    <div className="text-[10px] text-[#6B5A4E]">Memories</div>
                    <div className="text-sm font-semibold">
                      {activeSelectedItem.data.memoriesCount}
                    </div>
                  </div>
                  <div>
                    <div className="text-[10px] text-[#6B5A4E]">Constraints</div>
                    <div className="text-sm font-semibold">
                      {activeSelectedItem.data.constraintsCount}
                    </div>
                  </div>
                </div>

                {renderDrawerColorCustomizer(activeSelectedItem.data.id, 'system')}

                {Object.keys(activeSelectedItem.data.parameters || {}).length > 0 && (
                  <div>
                    <h3 className="font-mono text-[11px] uppercase tracking-wider text-[#6B5A4E] mb-2">
                      Parameters
                    </h3>
                    <pre className="bg-[#D2D8CA] border border-[#B6BEAE] p-2.5 font-mono text-[11px] text-[#18120F] rounded-xs overflow-x-auto whitespace-pre-wrap break-all">
                      {JSON.stringify(activeSelectedItem.data.parameters, null, 2)}
                    </pre>
                  </div>
                )}

                <div>
                  <h3 className="font-mono text-[11px] uppercase tracking-wider text-[#6B5A4E] mb-2">
                    Nested Subsystems
                  </h3>
                  {activeSelectedItem.data.subsystems.length === 0 ? (
                    <p className="font-mono text-[11px] text-[#6B5A4E]">
                      No nested subsystems recorded.
                    </p>
                  ) : (
                    <div className="space-y-2">
                      {activeSelectedItem.data.subsystems.map((sub) => (
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
                  {activeSelectedItem.data.functions.length === 0 ? (
                    <p className="font-mono text-[11px] text-[#6B5A4E]">No functions recorded.</p>
                  ) : (
                    <div className="space-y-2.5">
                      {activeSelectedItem.data.functions.map((fn) => (
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

                {activeSelectedItem.isCustom && (
                  <button
                    type="button"
                    onClick={() => handleDeleteNode(activeSelectedItem.data.id)}
                    className="w-full inline-flex items-center justify-center gap-2 px-4 py-2 bg-[#B91C1C] hover:bg-[#991B1B] text-[#FEF2F2] font-mono text-xs font-semibold rounded-xs transition-colors cursor-pointer"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    <span>Delete Custom System</span>
                  </button>
                )}
              </div>
            )}

            {activeSelectedItem.kind === 'subsystem' && (
              <div className="flex-1 overflow-y-auto p-5 space-y-4 text-xs">
                <div className="font-mono text-[11px] text-[#5D5046] border-b border-[#C5CBBF] pb-2">
                  Parent System:{' '}
                  <span className="font-semibold text-[#18120F]">
                    {activeSelectedItem.data.systemName}
                  </span>
                </div>
                {activeSelectedItem.isCustom && (
                  <div className="space-y-2 bg-[#D2D8CA] border border-[#B6BEAE] p-3 rounded-xs font-mono">
                    <label className="flex flex-col gap-1">
                      <span className="text-[10px] uppercase text-[#5D5046]">Name</span>
                      <input
                        type="text"
                        value={activeSelectedItem.data.name}
                        onChange={(e) =>
                          updateCustomDomainField(activeSelectedItem.data.id, {
                            title: e.target.value,
                          })
                        }
                        className="bg-[#EEF1EA] border border-[#9DA594] px-2 py-1 rounded-xs text-xs text-[#18120F]"
                      />
                    </label>
                    <label className="flex flex-col gap-1">
                      <span className="text-[10px] uppercase text-[#5D5046]">Responsibility</span>
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
                    Subsystem Responsibility
                  </h3>
                  <p className="text-sm text-[#2C221D] leading-relaxed">
                    {activeSelectedItem.data.description || 'No description recorded.'}
                  </p>
                </div>
                <div>
                  <h3 className="font-mono text-[11px] uppercase tracking-wider text-[#6B5A4E] mb-1.5">
                    Interface Contract
                  </h3>
                  <pre className="bg-[#18120F] text-[#DDD6FE] p-3 font-mono text-[11px] rounded-xs whitespace-pre-wrap break-all">
                    {activeSelectedItem.data.contract || '{}'}
                  </pre>
                </div>
                {renderDrawerColorCustomizer(activeSelectedItem.data.id, 'subsystem')}
                {activeSelectedItem.isCustom && (
                  <button
                    type="button"
                    onClick={() => handleDeleteNode(activeSelectedItem.data.id)}
                    className="w-full inline-flex items-center justify-center gap-2 px-4 py-2 bg-[#B91C1C] hover:bg-[#991B1B] text-[#FEF2F2] font-mono text-xs font-semibold rounded-xs transition-colors cursor-pointer"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    <span>Delete Custom Subsystem</span>
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

export function SystemsGraphView(props: SystemsGraphViewProps) {
  return (
    <ReactFlowProvider>
      <SystemsGraphCanvas {...props} />
    </ReactFlowProvider>
  );
}
