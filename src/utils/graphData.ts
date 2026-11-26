import { MarkerType, type Edge, type Node } from '@xyflow/react';
import type {
  GoalGraphNodeData,
  SkillRecord,
  SubstrateSystem,
  SubstrateSystemEdge,
  TaskContextLimit,
  TaskGraphNodeData,
  VisionGoalTaskEdge,
  VisionGraphNodeData,
} from '../types/substrate';

export function formatContextUsage(limit: TaskContextLimit): {
  percent: number;
  usedLabel: string;
  maxLabel: string;
} {
  const safeMax = Math.max(1, limit.maxTokens);
  const percent = Math.min(100, Math.round((limit.usedTokens / safeMax) * 100));
  const usedLabel = `${Math.round(limit.usedTokens / 1000)}k`;
  const maxLabel = `${Math.round(safeMax / 1000)}k`;
  return { percent, usedLabel, maxLabel };
}

export const SYSTEM_NODE_SIZE = { width: 300, height: 124 };
export const SUBSYSTEM_NODE_SIZE = { width: 268, height: 90 };
export const VISION_NODE_SIZE = { width: 356, height: 162 };
export const GOAL_NODE_SIZE = { width: 304, height: 118 };
export const TASK_NODE_SIZE = { width: 276, height: 98 };

export interface SystemsGraphBuildOptions {
  systems: SubstrateSystem[];
  edges: SubstrateSystemEdge[];
  showWormholes: boolean;
  focusedSystemId?: string | null;
}

export function buildSystemsGraph(
  options: SystemsGraphBuildOptions
): {
  nodes: Node[];
  edges: Edge[];
} {
  const { systems, edges: rawEdges, showWormholes, focusedSystemId = null } = options;

  if (systems.length === 0) {
    return { nodes: [], edges: [] };
  }

  // Nested view: inside a single System -> show its Subsystems cleanly
  if (focusedSystemId) {
    const focused = systems.find((s) => s.id === focusedSystemId);
    if (!focused || focused.subsystems.length === 0) {
      return { nodes: [], edges: [] };
    }

    const subs = focused.subsystems;
    const cols = subs.length >= 16 ? 5 : subs.length >= 7 ? 4 : 3;
    const colGap = 72;
    const rowGap = 52;

    const nodes: Node[] = subs.map((sub, idx) => {
      const c = idx % cols;
      const r = Math.floor(idx / cols);
      return {
        id: sub.id,
        type: 'subsystemNode',
        position: {
          x: 24 + c * (SUBSYSTEM_NODE_SIZE.width + colGap),
          y: 24 + r * (SUBSYSTEM_NODE_SIZE.height + rowGap),
        },
        width: SUBSYSTEM_NODE_SIZE.width,
        height: SUBSYSTEM_NODE_SIZE.height,
        style: { width: SUBSYSTEM_NODE_SIZE.width, height: SUBSYSTEM_NODE_SIZE.height },
        data: { ...sub, systemName: focused.name },
      };
    });

    return { nodes, edges: [] };
  }

  // Root view: Systems topology
  const cols = Math.min(3, Math.max(1, systems.length));
  const colGap = 136;
  const rowGap = 104;

  const nodes: Node[] = [];
  const gridCoord = new Map<string, { r: number; c: number }>();

  systems.forEach((sys, index) => {
    const r = Math.floor(index / cols);
    const c = index % cols;
    gridCoord.set(sys.id, { r, c });

    nodes.push({
      id: sys.id,
      type: 'systemNode',
      position: {
        x: 24 + c * (SYSTEM_NODE_SIZE.width + colGap),
        y: 24 + r * (SYSTEM_NODE_SIZE.height + rowGap),
      },
      width: SYSTEM_NODE_SIZE.width,
      height: SYSTEM_NODE_SIZE.height,
      style: { width: SYSTEM_NODE_SIZE.width, height: SYSTEM_NODE_SIZE.height },
      data: { ...sys },
    });
  });

  const visibleIds = new Set(nodes.map((n) => n.id));

  const edges: Edge[] = rawEdges
    .filter(
      (edge) =>
        visibleIds.has(edge.source) &&
        visibleIds.has(edge.target) &&
        (showWormholes || !edge.isWormhole)
    )
    .map((edge) => {
      const srcCoord = gridCoord.get(edge.source);
      const tgtCoord = gridCoord.get(edge.target);
      let sourceHandle = 's-right';
      let targetHandle = 't-left';
      if (srcCoord && tgtCoord) {
        if (srcCoord.c < tgtCoord.c) {
          sourceHandle = 's-right';
          targetHandle = 't-left';
        } else if (srcCoord.c > tgtCoord.c) {
          sourceHandle = 's-left';
          targetHandle = 't-right';
        } else if (srcCoord.r < tgtCoord.r) {
          sourceHandle = 's-bottom';
          targetHandle = 't-top';
        } else {
          sourceHandle = 's-top';
          targetHandle = 't-bottom';
        }
      }

      const strokeColor = edge.isWormhole ? '#D9441E' : '#7D6659';
      return {
        id: edge.id,
        type: 'smoothstep',
        source: edge.source,
        target: edge.target,
        sourceHandle,
        targetHandle,
        label: edge.label,
        animated: false,
        zIndex: 10,
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color: strokeColor,
          width: 14,
          height: 14,
        },
        style: {
          stroke: strokeColor,
          strokeWidth: edge.isWormhole ? 2 : 1.5,
          strokeDasharray: edge.isWormhole ? '6 4' : undefined,
        },
        labelStyle: {
          fill: '#D8CFC2',
          fontSize: 10,
          fontFamily: 'JetBrains Mono, ui-monospace, monospace',
        },
        labelBgStyle: {
          fill: '#1D1411',
          fillOpacity: 0.94,
        },
        labelBgPadding: [6, 3] as [number, number],
      };
    });

  return { nodes, edges };
}

export type VisionsGoalsScope =
  | { level: 'root' }
  | { level: 'vision'; visionId: string }
  | { level: 'goal'; goalId: string }
  | { level: 'task'; taskId: string };

export interface VisionsGoalsBuildOptions {
  visions: VisionGraphNodeData[];
  goals: GoalGraphNodeData[];
  tasks: TaskGraphNodeData[];
  edges: VisionGoalTaskEdge[];
  scope?: VisionsGoalsScope;
}

function layoutGridPositions<T extends { id: string }>(
  items: T[],
  size: { width: number; height: number },
  startX: number,
  startY: number,
  colGap: number,
  rowGap: number,
  maxCols: number
): { positions: Map<string, { x: number; y: number }>; maxBottom: number } {
  const positions = new Map<string, { x: number; y: number }>();
  if (items.length === 0) {
    return { positions, maxBottom: startY };
  }

  const cols = Math.min(maxCols, Math.max(1, items.length));
  let maxBottom = startY;

  items.forEach((item, idx) => {
    const c = idx % cols;
    const r = Math.floor(idx / cols);
    const x = startX + c * (size.width + colGap);
    const y = startY + r * (size.height + rowGap);
    positions.set(item.id, { x, y });
    maxBottom = Math.max(maxBottom, y + size.height);
  });

  return { positions, maxBottom };
}

function layoutLayeredOrGrid<T extends { id: string }>(
  items: T[],
  edges: VisionGoalTaskEdge[],
  size: { width: number; height: number },
  colGap: number,
  rowGap: number,
  maxGridCols: number
): Map<string, { x: number; y: number }> {
  const itemIds = new Set(items.map((i) => i.id));
  const internalEdges = edges.filter((e) => itemIds.has(e.source) && itemIds.has(e.target));

  if (internalEdges.length === 0) {
    const idealCols = Math.min(maxGridCols, Math.max(1, Math.ceil(Math.sqrt(items.length * 1.25))));
    return layoutGridPositions(items, size, 24, 24, colGap, rowGap, idealCols).positions;
  }

  const inDegree = new Map<string, number>();
  const adj = new Map<string, string[]>();
  const layerMap = new Map<string, number>();

  for (const item of items) {
    inDegree.set(item.id, 0);
    adj.set(item.id, []);
    layerMap.set(item.id, 0);
  }

  for (const edge of internalEdges) {
    if (edge.source === edge.target) continue;
    adj.get(edge.source)?.push(edge.target);
    inDegree.set(edge.target, (inDegree.get(edge.target) ?? 0) + 1);
  }

  const queue: string[] = [];
  for (const item of items) {
    if ((inDegree.get(item.id) ?? 0) === 0) {
      queue.push(item.id);
    }
  }

  const visited = new Set<string>();
  let head = 0;
  while (head < queue.length) {
    const cur = queue[head++];
    visited.add(cur);
    const curLayer = layerMap.get(cur) ?? 0;
    for (const nxt of adj.get(cur) ?? []) {
      layerMap.set(nxt, Math.max(layerMap.get(nxt) ?? 0, curLayer + 1));
      const nextDeg = (inDegree.get(nxt) ?? 0) - 1;
      inDegree.set(nxt, nextDeg);
      if (nextDeg === 0) {
        queue.push(nxt);
      }
    }
  }

  let maxLayer = 0;
  for (const l of layerMap.values()) {
    maxLayer = Math.max(maxLayer, l);
  }
  for (const item of items) {
    if (!visited.has(item.id)) {
      layerMap.set(item.id, maxLayer + 1);
    }
  }

  const columns = new Map<number, T[]>();
  for (const item of items) {
    const l = layerMap.get(item.id) ?? 0;
    const list = columns.get(l) ?? [];
    list.push(item);
    columns.set(l, list);
  }

  const sortedLayers = Array.from(columns.keys()).sort((a, b) => a - b);
  const subColumns: T[][] = [];
  for (const l of sortedLayers) {
    const colItems = columns.get(l) ?? [];
    const maxRows = items.length >= 12 ? 4 : 5;
    if (colItems.length <= maxRows) {
      subColumns.push(colItems);
    } else {
      const numSubCols = Math.min(4, Math.ceil(colItems.length / maxRows));
      const rowsPerSubCol = Math.ceil(colItems.length / numSubCols);
      for (let i = 0; i < colItems.length; i += rowsPerSubCol) {
        subColumns.push(colItems.slice(i, i + rowsPerSubCol));
      }
    }
  }

  let maxColHeight = 0;
  for (const subCol of subColumns) {
    const count = subCol.length;
    const h = count * size.height + Math.max(0, count - 1) * rowGap;
    maxColHeight = Math.max(maxColHeight, h);
  }

  const positions = new Map<string, { x: number; y: number }>();
  subColumns.forEach((colItems, colIdx) => {
    const colHeight = colItems.length * size.height + Math.max(0, colItems.length - 1) * rowGap;
    const offsetY = 24 + Math.max(0, (maxColHeight - colHeight) / 2);
    const x = 24 + colIdx * (size.width + colGap);
    colItems.forEach((item, rowIdx) => {
      positions.set(item.id, {
        x,
        y: offsetY + rowIdx * (size.height + rowGap),
      });
    });
  });

  return positions;
}

function buildStyledEdges(rawEdges: VisionGoalTaskEdge[], visibleIds: Set<string>): Edge[] {
  return rawEdges
    .filter((e) => visibleIds.has(e.source) && visibleIds.has(e.target))
    .map((e) => {
      const isTaskFlow = e.edgeKind === 'task_dependency' || e.edgeKind === 'artifact_flow';
      const isGate = e.edgeKind === 'goal_dependency' || e.edgeKind === 'vision_dependency';
      const strokeColor = isTaskFlow ? '#38BDF8' : isGate ? '#F59E0B' : '#8C7263';
      return {
        id: e.id,
        type: 'smoothstep',
        source: e.source,
        target: e.target,
        label: e.label,
        animated: false,
        zIndex: 25,
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color: strokeColor,
          width: 14,
          height: 14,
        },
        style: {
          stroke: strokeColor,
          strokeWidth: isGate ? 2.2 : 1.8,
          strokeDasharray:
            e.edgeKind === 'goal_dependency' || e.dependencyType === 'advisory' ? '5 4' : undefined,
        },
        labelStyle: {
          fill: '#E2DACD',
          fontSize: 10,
          fontFamily: 'JetBrains Mono, ui-monospace, monospace',
        },
        labelBgStyle: {
          fill: '#1D1411',
          fillOpacity: 0.94,
        },
        labelBgPadding: [6, 3] as [number, number],
      };
    });
}

/**
 * Guarantees every goal belongs to a Vision container so root always renders ONLY Visions.
 */
export function normalizeVisionsHierarchy(
  visions: VisionGraphNodeData[],
  goals: GoalGraphNodeData[]
): { visions: VisionGraphNodeData[]; goals: GoalGraphNodeData[] } {
  const visionIds = new Set(visions.map((v) => v.id));
  const orphanGoals = goals.filter((g) => !g.visionId || !visionIds.has(g.visionId));

  if (orphanGoals.length === 0) {
    return { visions, goals };
  }

  const fallbackVisionId = 'vision-unassigned-goals';
  const nextGoals = goals.map((g) =>
    !g.visionId || !visionIds.has(g.visionId) ? { ...g, visionId: fallbackVisionId } : g
  );

  const starts = orphanGoals
    .map((g) => g.createdAt)
    .filter((d): d is string => Boolean(d))
    .sort((a, b) => Date.parse(a) - Date.parse(b));
  const deadlines = orphanGoals
    .map((g) => g.deadlineAt)
    .filter((d): d is string => Boolean(d))
    .sort((a, b) => Date.parse(a) - Date.parse(b));

  const fallbackVision: VisionGraphNodeData = {
    id: fallbackVisionId,
    readableKey: 'VIS-GENERAL',
    title: 'General Substrate Vision',
    description: 'Container vision for substrate goals not yet bound to a specific vision target.',
    targetType: 'system',
    targetLabel: 'substrate',
    status: orphanGoals.some((g) => g.status === 'blocked') ? 'blocked' : 'active',
    goalsCount: orphanGoals.length,
    createdAt: starts[0] ?? null,
    deadlineAt: deadlines[0] ?? null,
    isDerived: true,
    position: { x: 24, y: 24 },
  };

  return {
    visions: [...visions, fallbackVision],
    goals: nextGoals,
  };
}

export function buildVisionsGoalsGraph(
  options: VisionsGoalsBuildOptions
): {
  nodes: Node[];
  edges: Edge[];
} {
  const { scope = { level: 'root' }, tasks, edges: rawEdges } = options;
  const { visions, goals } = normalizeVisionsHierarchy(options.visions, options.goals);

  // Level 2: Inside a Vision -> show its Goals cleanly
  if (scope.level === 'vision') {
    const childGoals = goals.filter((g) => g.visionId === scope.visionId);
    if (childGoals.length === 0) {
      return { nodes: [], edges: [] };
    }
    const goalCols = childGoals.length >= 16 ? 5 : childGoals.length >= 7 ? 4 : 3;
    const positions = layoutLayeredOrGrid(
      childGoals,
      rawEdges,
      GOAL_NODE_SIZE,
      88,
      64,
      goalCols
    );
    const nodes: Node[] = childGoals.map((goal) => ({
      id: goal.id,
      type: 'goalNode',
      position: positions.get(goal.id) ?? { x: 24, y: 24 },
      width: GOAL_NODE_SIZE.width,
      height: GOAL_NODE_SIZE.height,
      style: { width: GOAL_NODE_SIZE.width, height: GOAL_NODE_SIZE.height },
      data: { ...goal },
    }));
    const visibleIds = new Set(nodes.map((n) => n.id));
    return { nodes, edges: buildStyledEdges(rawEdges, visibleIds) };
  }

  // Level 3: Inside a Goal -> show its Tasks cleanly
  if (scope.level === 'goal') {
    const childTasks = tasks.filter((t) => t.goalId === scope.goalId);
    if (childTasks.length === 0) {
      return { nodes: [], edges: [] };
    }
    const taskCols = childTasks.length >= 16 ? 5 : childTasks.length >= 7 ? 4 : 3;
    const positions = layoutLayeredOrGrid(
      childTasks,
      rawEdges,
      TASK_NODE_SIZE,
      84,
      52,
      taskCols
    );
    const nodes: Node[] = childTasks.map((task) => ({
      id: task.id,
      type: 'taskNode',
      position: positions.get(task.id) ?? { x: 24, y: 24 },
      width: TASK_NODE_SIZE.width,
      height: TASK_NODE_SIZE.height,
      style: { width: TASK_NODE_SIZE.width, height: TASK_NODE_SIZE.height },
      data: { ...task },
    }));
    const visibleIds = new Set(nodes.map((n) => n.id));
    return { nodes, edges: buildStyledEdges(rawEdges, visibleIds) };
  }

  // Level 4: Inside a Task -> show subtasks if present, or focused task node
  if (scope.level === 'task') {
    const subtasks = tasks.filter((t) => t.parentTaskId === scope.taskId);
    const focused = tasks.find((t) => t.id === scope.taskId);
    const displayTasks = subtasks.length > 0 ? subtasks : focused ? [focused] : [];
    if (displayTasks.length === 0) {
      return { nodes: [], edges: [] };
    }
    const positions = layoutLayeredOrGrid(
      displayTasks,
      rawEdges,
      TASK_NODE_SIZE,
      84,
      52,
      3
    );
    const nodes: Node[] = displayTasks.map((task) => ({
      id: task.id,
      type: 'taskNode',
      position: positions.get(task.id) ?? { x: 24, y: 24 },
      width: TASK_NODE_SIZE.width,
      height: TASK_NODE_SIZE.height,
      style: { width: TASK_NODE_SIZE.width, height: TASK_NODE_SIZE.height },
      data: { ...task },
    }));
    const visibleIds = new Set(nodes.map((n) => n.id));
    return { nodes, edges: buildStyledEdges(rawEdges, visibleIds) };
  }

  // Level 1 (Root): ONLY show Vision nodes! Goals are always contained inside Visions.
  if (visions.length === 0) {
    return { nodes: [], edges: [] };
  }

  const goalToVisionId = new Map<string, string>();
  for (const g of goals) {
    if (g.visionId) goalToVisionId.set(g.id, g.visionId);
  }

  // Derive cross-vision dependency edges from goal_dependency edges that cross vision boundaries
  const visionEdges: VisionGoalTaskEdge[] = rawEdges.filter((e) => e.edgeKind === 'vision_dependency');
  const seenVisionPairs = new Set<string>(visionEdges.map((e) => `${e.source}->${e.target}`));

  for (const edge of rawEdges) {
    if (edge.edgeKind !== 'goal_dependency') continue;
    const srcV = goalToVisionId.get(edge.source);
    const tgtV = goalToVisionId.get(edge.target);
    if (srcV && tgtV && srcV !== tgtV) {
      const pairKey = `${srcV}->${tgtV}`;
      if (!seenVisionPairs.has(pairKey)) {
        seenVisionPairs.add(pairKey);
        visionEdges.push({
          id: `vd-derived-${srcV}-${tgtV}`,
          source: srcV,
          target: tgtV,
          edgeKind: 'vision_dependency',
          dependencyType: edge.dependencyType,
          label: edge.label,
        });
      }
    }
  }

  const visionCols = visions.length >= 16 ? 6 : visions.length >= 7 ? 4 : 3;
  const positions = layoutLayeredOrGrid(
    visions,
    visionEdges,
    VISION_NODE_SIZE,
    92,
    68,
    visionCols
  );

  const nodes: Node[] = visions.map((vision) => ({
    id: vision.id,
    type: 'visionNode',
    position: positions.get(vision.id) ?? { x: 24, y: 24 },
    width: VISION_NODE_SIZE.width,
    height: VISION_NODE_SIZE.height,
    style: { width: VISION_NODE_SIZE.width, height: VISION_NODE_SIZE.height },
    data: { ...vision },
  }));

  const visibleIds = new Set(nodes.map((n) => n.id));
  return { nodes, edges: buildStyledEdges(visionEdges, visibleIds) };
}

export function filterSkills(
  skills: SkillRecord[],
  query: string,
  category: string
): SkillRecord[] {
  const normalizedQuery = query.trim().toLowerCase();
  return skills.filter((skill) => {
    const matchesCategory = category === 'All' || skill.category === category;
    const matchesQuery =
      !normalizedQuery ||
      skill.name.toLowerCase().includes(normalizedQuery) ||
      skill.slug.toLowerCase().includes(normalizedQuery) ||
      (skill.description || '').toLowerCase().includes(normalizedQuery) ||
      skill.tools.some((t) => t.slug.toLowerCase().includes(normalizedQuery));
    return matchesCategory && matchesQuery;
  });
}
