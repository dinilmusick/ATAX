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

export interface SystemsGraphBuildOptions {
  systems: SubstrateSystem[];
  edges: SubstrateSystemEdge[];
  showWormholes: boolean;
  expandedSystemIds?: string[] | Set<string>;
}

const SYSTEM_COLLAPSED_SIZE = { width: 310, height: 56 };
const SUBSYSTEM_SIZE = { width: 280, height: 50 };

export function buildSystemsGraph(
  options: SystemsGraphBuildOptions
): {
  nodes: Node[];
  edges: Edge[];
} {
  const { systems, edges: rawEdges, showWormholes } = options;
  const expandedSet = new Set<string>(options.expandedSystemIds ?? []);

  if (systems.length === 0) {
    return { nodes: [], edges: [] };
  }

  const cols = Math.min(3, Math.max(1, systems.length));
  const rowsCount = Math.ceil(systems.length / cols);

  const sysDims = new Map<
    string,
    { width: number; height: number; expanded: boolean; subCols: number }
  >();
  const subPadSide = 20;
  const subPadTop = 66;
  const subPadBottom = 16;
  const subGapX = 16;
  const subGapY = 12;

  for (const sys of systems) {
    const expanded = expandedSet.has(sys.id) && sys.subsystems.length > 0;
    if (!expanded) {
      sysDims.set(sys.id, { ...SYSTEM_COLLAPSED_SIZE, expanded: false, subCols: 1 });
    } else {
      const subCols = sys.subsystems.length > 12 ? 3 : sys.subsystems.length > 4 ? 2 : 1;
      const subRows = Math.ceil(sys.subsystems.length / subCols);
      const width = Math.max(
        328,
        subPadSide * 2 + subCols * SUBSYSTEM_SIZE.width + Math.max(0, subCols - 1) * subGapX
      );
      const height =
        subPadTop +
        subRows * SUBSYSTEM_SIZE.height +
        Math.max(0, subRows - 1) * subGapY +
        subPadBottom;
      sysDims.set(sys.id, { width, height, expanded: true, subCols });
    }
  }

  const colWidths = Array.from({ length: cols }, (_, c) => {
    let maxW = SYSTEM_COLLAPSED_SIZE.width;
    for (let r = 0; r < rowsCount; r++) {
      const sys = systems[r * cols + c];
      if (sys) {
        maxW = Math.max(maxW, sysDims.get(sys.id)?.width ?? SYSTEM_COLLAPSED_SIZE.width);
      }
    }
    return maxW;
  });

  const rowHeights = Array.from({ length: rowsCount }, (_, r) => {
    let maxH = SYSTEM_COLLAPSED_SIZE.height;
    for (let c = 0; c < cols; c++) {
      const sys = systems[r * cols + c];
      if (sys) {
        maxH = Math.max(maxH, sysDims.get(sys.id)?.height ?? SYSTEM_COLLAPSED_SIZE.height);
      }
    }
    return maxH;
  });

  const colGap = 136;
  const rowGap = 108;
  const colX: number[] = [];
  let cursorX = 20;
  for (let c = 0; c < cols; c++) {
    colX.push(cursorX);
    cursorX += colWidths[c] + colGap;
  }

  const rowY: number[] = [];
  let cursorY = 20;
  for (let r = 0; r < rowsCount; r++) {
    rowY.push(cursorY);
    cursorY += rowHeights[r] + rowGap;
  }

  const nodes: Node[] = [];
  const gridCoord = new Map<string, { r: number; c: number }>();

  systems.forEach((sys, index) => {
    const r = Math.floor(index / cols);
    const c = index % cols;
    const dims = sysDims.get(sys.id) ?? { ...SYSTEM_COLLAPSED_SIZE, expanded: false, subCols: 1 };
    gridCoord.set(sys.id, { r, c });

    nodes.push({
      id: sys.id,
      type: 'systemNode',
      position: { x: colX[c], y: rowY[r] },
      width: dims.width,
      height: dims.height,
      style: { width: dims.width, height: dims.height },
      data: { ...sys, expanded: dims.expanded },
    });

    if (dims.expanded) {
      sys.subsystems.forEach((sub, idx) => {
        const subCol = idx % dims.subCols;
        const subRow = Math.floor(idx / dims.subCols);
        nodes.push({
          id: sub.id,
          type: 'subsystemNode',
          parentId: sys.id,
          extent: 'parent',
          position: {
            x: subPadSide + subCol * (SUBSYSTEM_SIZE.width + subGapX),
            y: subPadTop + subRow * (SUBSYSTEM_SIZE.height + subGapY),
          },
          width: SUBSYSTEM_SIZE.width,
          height: SUBSYSTEM_SIZE.height,
          style: { width: SUBSYSTEM_SIZE.width, height: SUBSYSTEM_SIZE.height },
          data: { ...sub, systemName: sys.name },
        });
      });
    }
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

export interface VisionsGoalsBuildOptions {
  visions: VisionGraphNodeData[];
  goals: GoalGraphNodeData[];
  tasks: TaskGraphNodeData[];
  edges: VisionGoalTaskEdge[];
  expandedVisionIds?: string[] | Set<string>;
  expandedGoalIds?: string[] | Set<string>;
}

const VISION_COLLAPSED_SIZE = { width: 350, height: 58 };
const GOAL_COLLAPSED_SIZE = { width: 316, height: 54 };
const TASK_CARD_SIZE = { width: 332, height: 54 };

function computeGoalSpec(
  goal: GoalGraphNodeData,
  childTasks: TaskGraphNodeData[],
  isGoalExpanded: boolean
): {
  goal: GoalGraphNodeData;
  expanded: boolean;
  width: number;
  height: number;
  tasks: Array<{ task: TaskGraphNodeData; x: number; y: number }>;
} {
  if (!isGoalExpanded || childTasks.length === 0) {
    return {
      goal,
      expanded: false,
      width: GOAL_COLLAPSED_SIZE.width,
      height: GOAL_COLLAPSED_SIZE.height,
      tasks: [],
    };
  }

  const taskPadSide = 20;
  const taskPadTop = 72;
  const taskPadBottom = 18;
  const taskGapX = 40;
  const taskGapY = 20;
  const tasksPerRow = Math.min(2, childTasks.length);
  const rows = Math.ceil(childTasks.length / tasksPerRow);

  const width = Math.max(
    GOAL_COLLAPSED_SIZE.width,
    taskPadSide * 2 +
      tasksPerRow * TASK_CARD_SIZE.width +
      Math.max(0, tasksPerRow - 1) * taskGapX
  );
  const height =
    taskPadTop +
    rows * TASK_CARD_SIZE.height +
    Math.max(0, rows - 1) * taskGapY +
    taskPadBottom;

  const tasks = childTasks.map((task, ti) => {
    const col = ti % tasksPerRow;
    const row = Math.floor(ti / tasksPerRow);
    return {
      task,
      x: taskPadSide + col * (TASK_CARD_SIZE.width + taskGapX),
      y: taskPadTop + row * (TASK_CARD_SIZE.height + taskGapY),
    };
  });

  return {
    goal,
    expanded: true,
    width,
    height,
    tasks,
  };
}

export function buildVisionsGoalsGraph(
  options: VisionsGoalsBuildOptions
): {
  nodes: Node[];
  edges: Edge[];
} {
  const { visions, goals, tasks, edges: rawEdges } = options;
  const expandedVisions = new Set<string>(options.expandedVisionIds ?? []);
  const expandedGoals = new Set<string>(options.expandedGoalIds ?? []);

  const nodes: Node[] = [];
  const visionIds = new Set(visions.map((v) => v.id));
  const goalIds = new Set(goals.map((g) => g.id));

  let cursorX = 20;
  let maxRowBottom = 20;
  const visionGap = 110;

  for (const vision of visions) {
    const isVisionExpanded = expandedVisions.has(vision.id);
    const childGoals = goals.filter((g) => g.visionId === vision.id);

    if (!isVisionExpanded) {
      nodes.push({
        id: vision.id,
        type: 'visionNode',
        position: { x: cursorX, y: 20 },
        width: VISION_COLLAPSED_SIZE.width,
        height: VISION_COLLAPSED_SIZE.height,
        style: { width: VISION_COLLAPSED_SIZE.width, height: VISION_COLLAPSED_SIZE.height },
        data: { ...vision, expanded: false },
      });
      cursorX += VISION_COLLAPSED_SIZE.width + visionGap;
      maxRowBottom = Math.max(maxRowBottom, 20 + VISION_COLLAPSED_SIZE.height);
      continue;
    }

    const goalPadSide = 26;
    const goalPadTop = 76;
    const goalPadBottom = 22;
    const goalGapX = 44;
    const goalGapY = 28;

    const goalSpecs = childGoals.map((goal) => {
      const childTasks = tasks.filter((t) => t.goalId === goal.id);
      return computeGoalSpec(goal, childTasks, expandedGoals.has(goal.id));
    });

    const goalsPerRow = Math.min(3, Math.max(1, goalSpecs.length));
    const goalRowsCount = Math.ceil(goalSpecs.length / goalsPerRow);

    const positionedGoals: Array<ReturnType<typeof computeGoalSpec> & { x: number; y: number }> = [];
    let currentY = goalPadTop;
    let maxRowWidth = VISION_COLLAPSED_SIZE.width;

    for (let r = 0; r < goalRowsCount; r++) {
      const rowSpecs = goalSpecs.slice(r * goalsPerRow, (r + 1) * goalsPerRow);
      let goalCursorX = goalPadSide;
      let rowMaxH = 0;
      for (const spec of rowSpecs) {
        positionedGoals.push({ ...spec, x: goalCursorX, y: currentY });
        goalCursorX += spec.width + goalGapX;
        rowMaxH = Math.max(rowMaxH, spec.height);
      }
      if (rowSpecs.length > 0) {
        maxRowWidth = Math.max(maxRowWidth, goalCursorX - goalGapX + goalPadSide);
        currentY += rowMaxH + goalGapY;
      }
    }

    const visionWidth = Math.max(VISION_COLLAPSED_SIZE.width, maxRowWidth);
    const visionHeight =
      positionedGoals.length > 0
        ? currentY - goalGapY + goalPadBottom
        : VISION_COLLAPSED_SIZE.height;

    nodes.push({
      id: vision.id,
      type: 'visionNode',
      position: { x: cursorX, y: 20 },
      width: visionWidth,
      height: visionHeight,
      style: { width: visionWidth, height: visionHeight },
      data: { ...vision, expanded: true },
    });

    for (const gSpec of positionedGoals) {
      nodes.push({
        id: gSpec.goal.id,
        type: 'goalNode',
        parentId: vision.id,
        extent: 'parent',
        position: { x: gSpec.x, y: gSpec.y },
        width: gSpec.width,
        height: gSpec.height,
        style: { width: gSpec.width, height: gSpec.height },
        data: { ...gSpec.goal, expanded: gSpec.expanded },
      });

      if (gSpec.expanded) {
        for (const tSpec of gSpec.tasks) {
          nodes.push({
            id: tSpec.task.id,
            type: 'taskNode',
            parentId: gSpec.goal.id,
            extent: 'parent',
            position: { x: tSpec.x, y: tSpec.y },
            width: TASK_CARD_SIZE.width,
            height: TASK_CARD_SIZE.height,
            style: { width: TASK_CARD_SIZE.width, height: TASK_CARD_SIZE.height },
            data: { ...tSpec.task },
          });
        }
      }
    }

    cursorX += visionWidth + visionGap;
    maxRowBottom = Math.max(maxRowBottom, 20 + visionHeight);
  }

  // Render any real goals from Supabase not attached to a Vision directly as top-level Goal nodes
  const standaloneGoals = goals.filter((g) => !g.visionId || !visionIds.has(g.visionId));
  if (standaloneGoals.length > 0) {
    const startY = visions.length > 0 ? maxRowBottom + 88 : 20;
    const cols =
      standaloneGoals.length <= 3
        ? standaloneGoals.length
        : Math.min(7, Math.max(3, Math.ceil(Math.sqrt(standaloneGoals.length * 0.55))));
    const colGap = 40;
    const rowGap = 36;
    let rowY = startY;

    for (let i = 0; i < standaloneGoals.length; i += cols) {
      const rowGoals = standaloneGoals.slice(i, i + cols);
      let colX = 20;
      let rowMaxH = 0;

      for (const goal of rowGoals) {
        const childTasks = tasks.filter((t) => t.goalId === goal.id);
        const gSpec = computeGoalSpec(goal, childTasks, expandedGoals.has(goal.id));

        nodes.push({
          id: gSpec.goal.id,
          type: 'goalNode',
          position: { x: colX, y: rowY },
          width: gSpec.width,
          height: gSpec.height,
          style: { width: gSpec.width, height: gSpec.height },
          data: { ...gSpec.goal, expanded: gSpec.expanded },
        });

        if (gSpec.expanded) {
          for (const tSpec of gSpec.tasks) {
            nodes.push({
              id: tSpec.task.id,
              type: 'taskNode',
              parentId: gSpec.goal.id,
              extent: 'parent',
              position: { x: tSpec.x, y: tSpec.y },
              width: TASK_CARD_SIZE.width,
              height: TASK_CARD_SIZE.height,
              style: { width: TASK_CARD_SIZE.width, height: TASK_CARD_SIZE.height },
              data: { ...tSpec.task },
            });
          }
        }

        colX += gSpec.width + colGap;
        rowMaxH = Math.max(rowMaxH, gSpec.height);
      }
      rowY += rowMaxH + rowGap;
      maxRowBottom = Math.max(maxRowBottom, rowY - rowGap);
    }
  }

  // Render any standalone tasks not linked to a Goal directly as top-level Task nodes
  const standaloneTasks = tasks.filter((t) => !t.goalId || !goalIds.has(t.goalId));
  if (standaloneTasks.length > 0) {
    const startY = nodes.length > 0 ? maxRowBottom + 72 : 20;
    const cols =
      standaloneTasks.length <= 3
        ? standaloneTasks.length
        : Math.min(7, Math.max(3, Math.ceil(Math.sqrt(standaloneTasks.length * 0.55))));
    const colGap = 40;
    const rowGap = 32;
    standaloneTasks.forEach((task, idx) => {
      const col = idx % cols;
      const row = Math.floor(idx / cols);
      nodes.push({
        id: task.id,
        type: 'taskNode',
        position: {
          x: 20 + col * (TASK_CARD_SIZE.width + colGap),
          y: startY + row * (TASK_CARD_SIZE.height + rowGap),
        },
        width: TASK_CARD_SIZE.width,
        height: TASK_CARD_SIZE.height,
        style: { width: TASK_CARD_SIZE.width, height: TASK_CARD_SIZE.height },
        data: { ...task },
      });
    });
  }

  const visibleIds = new Set(nodes.map((n) => n.id));

  const edges: Edge[] = rawEdges
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
          stroke: isTaskFlow ? '#DF6B3B' : isGate ? '#C83214' : '#8C7263',
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

  return { nodes, edges };
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
