import type {
  BranchingNodeItem,
  BranchingNodeKind,
  CustomDomainNodeItem,
  CustomEdgeItem,
  GroupingBoxItem,
  NodeColorPreferences,
  NodeDeadlineOverride,
  NodeTypeKey,
  SavedNodePositionsMap,
  StickyNoteItem,
} from '../types/substrate';

export const DEFAULT_NODE_BODY_COLORS: Record<NodeTypeKey, string> = {
  vision: '#0A2920',
  goal: '#2E1A05',
  task: '#0D1E36',
  system: '#24130E',
  subsystem: '#1E1233',
  multi_in_single_out: '#0B2A30',
  single_in_multi_out: '#331016',
  fan_out: '#162712',
};

export const NODE_COLOR_PRESETS: Array<{ label: string; color: string }> = [
  { label: 'Emerald Forest', color: '#0A2920' },
  { label: 'Burnished Amber', color: '#2E1A05' },
  { label: 'Deep Cobalt', color: '#0D1E36' },
  { label: 'Iron Copper', color: '#24130E' },
  { label: 'Plum Violet', color: '#1E1233' },
  { label: 'Crimson Slate', color: '#331016' },
  { label: 'Teal Abyss', color: '#0B2A30' },
  { label: 'Moss Canopy', color: '#162712' },
  { label: 'Warm Parchment', color: '#DFE4D8' },
  { label: 'Sandstone Gold', color: '#E8D5B5' },
];

export const STICKY_NOTE_COLORS: Array<{ label: string; hex: string }> = [
  { label: 'Canary', hex: '#FEF08A' },
  { label: 'Mint', hex: '#BBF7D0' },
  { label: 'Sky', hex: '#BAE6FD' },
  { label: 'Peach', hex: '#FED7AA' },
  { label: 'Rose', hex: '#FECDD3' },
];

export const GROUP_BOX_COLORS: Array<{ label: string; hex: string }> = [
  { label: 'Terracotta', hex: '#E04819' },
  { label: 'Emerald', hex: '#10B981' },
  { label: 'Amber', hex: '#F59E0B' },
  { label: 'Cobalt', hex: '#38BDF8' },
  { label: 'Violet', hex: '#A78BFA' },
];

const STORAGE_KEYS = {
  colors: 'atax.nodeColors.v1',
  stickyNotes: 'atax.stickyNotes.v1',
  groupBoxes: 'atax.groupBoxes.v1',
  deadlines: 'atax.nodeDeadlines.v1',
  branchingNodes: 'atax.branchingNodes.v1',
  customDomainNodes: 'atax.customDomainNodes.v1',
  customEdges: 'atax.customEdges.v1',
  savedPositions: 'atax.nodePositions.v1',
};

function canUseStorage(): boolean {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

function readJsonFromStorage<T>(key: string, fallback: T): T {
  if (!canUseStorage()) return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

let syncTimer: ReturnType<typeof setTimeout> | null = null;

export function syncVisualStateToServer(): void {
  if (typeof window === 'undefined' || typeof fetch === 'undefined') return;
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(async () => {
    try {
      const payload = {
        stickyNotes: loadStickyNotes(),
        groupBoxes: loadGroupingBoxes(),
        branchingNodes: loadBranchingNodes(),
        customDomainNodes: loadCustomDomainNodes(),
        customEdges: loadCustomEdges(),
        savedPositions: loadSavedNodePositions(),
        nodeColors: loadNodeColorPreferences(),
        deadlineOverrides: loadDeadlineOverrides(),
      };
      await fetch('/api/substrate/visual-state', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } catch {
      // ignore network errors on background sync
    }
  }, 250);
}

export async function pullVisualStateFromServer(): Promise<boolean> {
  if (typeof window === 'undefined' || typeof fetch === 'undefined') return false;
  try {
    const res = await fetch('/api/substrate/visual-state');
    if (!res.ok) return false;
    const data = (await res.json()) as Record<string, unknown>;
    if (!data || typeof data !== 'object') return false;

    if (Array.isArray(data.stickyNotes)) {
      writeJsonToStorage(STORAGE_KEYS.stickyNotes, data.stickyNotes, false);
    }
    if (Array.isArray(data.groupBoxes)) {
      writeJsonToStorage(STORAGE_KEYS.groupBoxes, data.groupBoxes, false);
    }
    if (Array.isArray(data.branchingNodes)) {
      writeJsonToStorage(STORAGE_KEYS.branchingNodes, data.branchingNodes, false);
    }
    if (Array.isArray(data.customDomainNodes)) {
      writeJsonToStorage(STORAGE_KEYS.customDomainNodes, data.customDomainNodes, false);
    }
    if (Array.isArray(data.customEdges)) {
      writeJsonToStorage(STORAGE_KEYS.customEdges, data.customEdges, false);
    }
    if (data.savedPositions && typeof data.savedPositions === 'object') {
      writeJsonToStorage(STORAGE_KEYS.savedPositions, data.savedPositions, false);
    }
    if (data.nodeColors && typeof data.nodeColors === 'object') {
      writeJsonToStorage(STORAGE_KEYS.colors, data.nodeColors, false);
    }
    if (data.deadlineOverrides && typeof data.deadlineOverrides === 'object') {
      writeJsonToStorage(STORAGE_KEYS.deadlines, data.deadlineOverrides, false);
    }
    return true;
  } catch {
    return false;
  }
}

function writeJsonToStorage(key: string, value: unknown, shouldSync = true): void {
  if (!canUseStorage()) return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
    if (shouldSync) {
      syncVisualStateToServer();
    }
  } catch {
    // ignore storage quota errors
  }
}

export function loadNodeColorPreferences(): NodeColorPreferences {
  const defaults: NodeColorPreferences = {
    byType: { ...DEFAULT_NODE_BODY_COLORS },
    byNodeId: {},
  };
  const parsed = readJsonFromStorage<Partial<NodeColorPreferences> | null>(
    STORAGE_KEYS.colors,
    null
  );
  if (!parsed || typeof parsed !== 'object') return defaults;
  return {
    byType: {
      ...DEFAULT_NODE_BODY_COLORS,
      ...(parsed.byType || {}),
    },
    byNodeId: parsed.byNodeId && typeof parsed.byNodeId === 'object' ? parsed.byNodeId : {},
  };
}

export function saveNodeColorPreferences(prefs: NodeColorPreferences): void {
  writeJsonToStorage(STORAGE_KEYS.colors, prefs);
}

export function resolveNodeBodyColor(
  prefs: NodeColorPreferences,
  nodeType: NodeTypeKey,
  nodeId?: string
): string {
  if (nodeId && prefs.byNodeId[nodeId]) {
    return prefs.byNodeId[nodeId];
  }
  return prefs.byType[nodeType] || DEFAULT_NODE_BODY_COLORS[nodeType];
}

export function loadStickyNotes(): StickyNoteItem[] {
  const parsed = readJsonFromStorage<unknown>(STORAGE_KEYS.stickyNotes, []);
  return Array.isArray(parsed) ? (parsed as StickyNoteItem[]) : [];
}

export function saveStickyNotes(items: StickyNoteItem[]): void {
  writeJsonToStorage(STORAGE_KEYS.stickyNotes, items);
}

export function loadGroupingBoxes(): GroupingBoxItem[] {
  const parsed = readJsonFromStorage<unknown>(STORAGE_KEYS.groupBoxes, []);
  return Array.isArray(parsed) ? (parsed as GroupingBoxItem[]) : [];
}

export function saveGroupingBoxes(items: GroupingBoxItem[]): void {
  writeJsonToStorage(STORAGE_KEYS.groupBoxes, items);
}

export function loadDeadlineOverrides(): Record<string, NodeDeadlineOverride> {
  const parsed = readJsonFromStorage<unknown>(STORAGE_KEYS.deadlines, {});
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as Record<string, NodeDeadlineOverride>)
    : {};
}

export function saveDeadlineOverrides(map: Record<string, NodeDeadlineOverride>): void {
  writeJsonToStorage(STORAGE_KEYS.deadlines, map);
}

export function loadBranchingNodes(): BranchingNodeItem[] {
  const parsed = readJsonFromStorage<unknown>(STORAGE_KEYS.branchingNodes, []);
  return Array.isArray(parsed) ? (parsed as BranchingNodeItem[]) : [];
}

export function saveBranchingNodes(items: BranchingNodeItem[]): void {
  writeJsonToStorage(STORAGE_KEYS.branchingNodes, items);
}

export function loadCustomDomainNodes(): CustomDomainNodeItem[] {
  const parsed = readJsonFromStorage<unknown>(STORAGE_KEYS.customDomainNodes, []);
  return Array.isArray(parsed) ? (parsed as CustomDomainNodeItem[]) : [];
}

export function saveCustomDomainNodes(items: CustomDomainNodeItem[]): void {
  writeJsonToStorage(STORAGE_KEYS.customDomainNodes, items);
}

export function loadCustomEdges(): CustomEdgeItem[] {
  const parsed = readJsonFromStorage<unknown>(STORAGE_KEYS.customEdges, []);
  return Array.isArray(parsed) ? (parsed as CustomEdgeItem[]) : [];
}

export function saveCustomEdges(items: CustomEdgeItem[]): void {
  writeJsonToStorage(STORAGE_KEYS.customEdges, items);
}

export function loadSavedNodePositions(): SavedNodePositionsMap {
  const parsed = readJsonFromStorage<unknown>(STORAGE_KEYS.savedPositions, {});
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as SavedNodePositionsMap)
    : {};
}

export function saveSavedNodePositions(map: SavedNodePositionsMap): void {
  writeJsonToStorage(STORAGE_KEYS.savedPositions, map);
}

export function createStickyNote(
  scopeKey: string,
  x: number,
  y: number,
  color = STICKY_NOTE_COLORS[0].hex
): StickyNoteItem {
  return {
    id: `sticky-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    scopeKey,
    text: '',
    color,
    x: Math.round(x),
    y: Math.round(y),
    width: 220,
    height: 164,
  };
}

export function createGroupingBox(
  scopeKey: string,
  x: number,
  y: number,
  title = 'Group',
  color = GROUP_BOX_COLORS[0].hex
): GroupingBoxItem {
  return {
    id: `group-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    scopeKey,
    title,
    color,
    x: Math.round(x),
    y: Math.round(y),
    width: 480,
    height: 300,
  };
}

export function defaultPortLabelsForBranching(kind: BranchingNodeKind, portCount: number): string[] {
  const count = Math.min(4, Math.max(2, Math.round(portCount)));
  if (kind === 'multi_in_single_out') {
    return Array.from({ length: count }, (_, idx) => `In ${idx + 1}`);
  }
  if (kind === 'single_in_multi_out') {
    const names = ['Route A', 'Route B', 'Fallback', 'Escalation'];
    return Array.from({ length: count }, (_, idx) => names[idx] || `Out ${idx + 1}`);
  }
  return Array.from({ length: count }, (_, idx) => `Lane ${idx + 1}`);
}

export function createBranchingNode(
  scopeKey: string,
  kind: BranchingNodeKind,
  x: number,
  y: number
): BranchingNodeItem {
  const portCount = 3;
  const meta: Record<BranchingNodeKind, { title: string; rule: string; description: string }> = {
    multi_in_single_out: {
      title: 'Multi-In Selector',
      rule: 'First Ready',
      description: 'Converges multiple upstream inputs and forwards the selected branch.',
    },
    single_in_multi_out: {
      title: 'Single-In Router',
      rule: 'Condition Match',
      description: 'Evaluates an incoming flow and routes execution to one output branch.',
    },
    fan_out: {
      title: 'Fan-Out Fork',
      rule: 'Parallel Broadcast',
      description: 'Dispatches an incoming signal concurrently across every connected output lane.',
    },
  };

  return {
    id: `branch-${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    scopeKey,
    kind,
    title: meta[kind].title,
    rule: meta[kind].rule,
    description: meta[kind].description,
    portCount,
    portLabels: defaultPortLabelsForBranching(kind, portCount),
    x: Math.round(x),
    y: Math.round(y),
  };
}

export function createCustomDomainNode(
  scopeKey: string,
  domainKind: CustomDomainNodeItem['domainKind'],
  x: number,
  y: number,
  parentId?: string | null,
  indexHint = 1
): CustomDomainNodeItem {
  const prefixMap: Record<CustomDomainNodeItem['domainKind'], string> = {
    vision: 'VIS-NEW',
    goal: 'GOAL-NEW',
    task: 'TASK-NEW',
    system: 'SYS-NEW',
    subsystem: 'SUB-NEW',
  };
  const titleMap: Record<CustomDomainNodeItem['domainKind'], string> = {
    vision: `Custom Vision ${indexHint}`,
    goal: `Custom Goal ${indexHint}`,
    task: `Custom Task ${indexHint}`,
    system: `Custom System ${indexHint}`,
    subsystem: `Custom Subsystem ${indexHint}`,
  };
  return {
    id: `custom-${domainKind}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    scopeKey,
    domainKind,
    parentId: parentId ?? null,
    readableKey: `${prefixMap[domainKind]}-${indexHint}`,
    title: titleMap[domainKind],
    description: 'User-created flow node. Click to edit details or connect edges.',
    status: 'active',
    subtitle: domainKind === 'system' || domainKind === 'subsystem' ? 'service' : 'flow',
    x: Math.round(x),
    y: Math.round(y),
  };
}

export function createCustomEdge(
  scopeKey: string,
  source: string,
  target: string,
  sourceHandle?: string | null,
  targetHandle?: string | null,
  label?: string
): CustomEdgeItem | null {
  if (!source || !target || source === target) return null;
  return {
    id: `cedge-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    scopeKey,
    source,
    target,
    sourceHandle: sourceHandle ?? null,
    targetHandle: targetHandle ?? null,
    label: label?.trim() || 'flow',
  };
}

export function appendUniqueCustomEdge(
  edges: CustomEdgeItem[],
  candidate: CustomEdgeItem | null
): CustomEdgeItem[] {
  if (!candidate) return edges;
  const duplicate = edges.some(
    (e) =>
      e.scopeKey === candidate.scopeKey &&
      e.source === candidate.source &&
      e.target === candidate.target &&
      (e.sourceHandle || '') === (candidate.sourceHandle || '') &&
      (e.targetHandle || '') === (candidate.targetHandle || '')
  );
  if (duplicate) return edges;
  return [...edges, candidate];
}

export function isPointInsideRect(
  px: number,
  py: number,
  rect: { x: number; y: number; width: number; height: number }
): boolean {
  return px >= rect.x && px <= rect.x + rect.width && py >= rect.y && py <= rect.y + rect.height;
}
