import type { Edge, Node } from '@xyflow/react';
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
export const VISION_NODE_SIZE = { width: 310, height: 140 };
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
    const cols = Math.min(3, Math.max(1, Math.ceil(Math.sqrt(subs.length * 1.25))));
    const colGap = 80;
    const rowGap = 60;

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

      return {
        id: edge.id,
        type: 'smoothstep',
        source: edge.source,
        target: edge.target,
        sourceHandle,
        targetHandle,
        label: edge.label,
        animated: Boolean(edge.isWormhole),
        zIndex: 10,
        style: {
          stroke: edge.isWormhole ? '#D9441E' : '#7D6659',
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
  | { level: 'goal'; goalId: string };

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
  let maxColHeight = 0;
  for (const l of sortedLayers) {
    const count = columns.get(l)?.length ?? 0;
    const h = count * size.height + Math.max(0, count - 1) * rowGap;
    maxColHeight = Math.max(maxColHeight, h);
  }

  const positions = new Map<string, { x: number; y: number }>();
  sortedLayers.forEach((l, colIdx) => {
    const colItems = columns.get(l) ?? [];
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
      return {
        id: e.id,
        type: 'smoothstep',
        source: e.source,
        target: e.target,
        label: e.label,
        animated: true,
        zIndex: 25,
        style: {
          stroke: isTaskFlow ? '#38BDF8' : isGate ? '#F59E0B' : '#8C7263',
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

export function buildVisionsGoalsGraph(
  options: VisionsGoalsBuildOptions
): {
  nodes: Node[];
  edges: Edge[];
} {
  const { visions, goals, tasks, edges: rawEdges, scope = { level: 'root' } } = options;
  const visionIds = new Set(visions.map((v) => v.id));
  const goalIds = new Set(goals.map((g) => g.id));

  // Level 2: Inside a Vision -> show its Goals cleanly
  if (scope.level === 'vision') {
    const childGoals = goals.filter((g) => g.visionId === scope.visionId);
    if (childGoals.length === 0) {
      return { nodes: [], edges: [] };
    }
    const positions = layoutLayeredOrGrid(
      childGoals,
      rawEdges,
      GOAL_NODE_SIZE,
      96,
      68,
      3
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
    const positions = layoutLayeredOrGrid(
      childTasks,
      rawEdges,
      TASK_NODE_SIZE,
      88,
      54,
      3
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

  // Level 1 (Root): show Visions, plus any standalone Goals, plus any standalone Tasks
  const nodes: Node[] = [];
  let nextStartY = 24;

  if (visions.length > 0) {
    const vLayout = layoutGridPositions(
      visions,
      VISION_NODE_SIZE,
      24,
      nextStartY,
      96,
      72,
      3
    );
    for (const vision of visions) {
      nodes.push({
        id: vision.id,
        type: 'visionNode',
        position: vLayout.positions.get(vision.id) ?? { x: 24, y: 24 },
        width: VISION_NODE_SIZE.width,
        height: VISION_NODE_SIZE.height,
        style: { width: VISION_NODE_SIZE.width, height: VISION_NODE_SIZE.height },
        data: { ...vision },
      });
    }
    nextStartY = vLayout.maxBottom + 84;
  }

  const standaloneGoals = goals.filter((g) => !g.visionId || !visionIds.has(g.visionId));
  if (standaloneGoals.length > 0) {
    const gLayout = layoutGridPositions(
      standaloneGoals,
      GOAL_NODE_SIZE,
      24,
      nextStartY,
      84,
      64,
      Math.min(4, Math.max(1, Math.ceil(Math.sqrt(standaloneGoals.length * 1.1))))
    );
    for (const goal of standaloneGoals) {
      nodes.push({
        id: goal.id,
        type: 'goalNode',
        position: gLayout.positions.get(goal.id) ?? { x: 24, y: nextStartY },
        width: GOAL_NODE_SIZE.width,
        height: GOAL_NODE_SIZE.height,
        style: { width: GOAL_NODE_SIZE.width, height: GOAL_NODE_SIZE.height },
        data: { ...goal },
      });
    }
    nextStartY = gLayout.maxBottom + 76;
  }

  const standaloneTasks = tasks.filter((t) => !t.goalId || !goalIds.has(t.goalId));
  if (standaloneTasks.length > 0) {
    const tLayout = layoutGridPositions(
      standaloneTasks,
      TASK_NODE_SIZE,
      24,
      nextStartY,
      72,
      54,
      Math.min(4, Math.max(1, Math.ceil(Math.sqrt(standaloneTasks.length * 1.1))))
    );
    for (const task of standaloneTasks) {
      nodes.push({
        id: task.id,
        type: 'taskNode',
        position: tLayout.positions.get(task.id) ?? { x: 24, y: nextStartY },
        width: TASK_NODE_SIZE.width,
        height: TASK_NODE_SIZE.height,
        style: { width: TASK_NODE_SIZE.width, height: TASK_NODE_SIZE.height },
        data: { ...task },
      });
    }
  }

  const visibleIds = new Set(nodes.map((n) => n.id));
  return { nodes, edges: buildStyledEdges(rawEdges, visibleIds) };
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
