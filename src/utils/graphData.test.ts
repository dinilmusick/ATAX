import test from 'node:test';
import assert from 'node:assert/strict';
import type {
  GoalGraphNodeData,
  SkillRecord,
  SubstrateSystem,
  SubstrateSystemEdge,
  TaskGraphNodeData,
  VisionGoalTaskEdge,
  VisionGraphNodeData,
} from '../types/substrate';
import {
  buildSystemsGraph,
  buildVisionsGoalsGraph,
  filterSkills,
  formatContextUsage,
} from './graphData';
import {
  applyUserAnchorsToNodes,
  createForceBodies,
  setForceBodyAnchor,
  stepForceSimulation,
} from './forcePhysics';

const FIXTURE_SYSTEMS: SubstrateSystem[] = [
  {
    id: 'sys-1',
    universeId: 'u-1',
    universeName: 'Core',
    systemKey: 'core-ledger',
    name: 'Core Ledger',
    systemType: 'database',
    status: 'active',
    description: 'Primary ledger',
    contextVersion: 2,
    parameters: { engine: 'postgres' },
    functions: [],
    memoriesCount: 3,
    constraintsCount: 1,
    subsystems: [
      {
        id: 'sub-1',
        systemId: 'sys-1',
        readableKey: 'sub-claims',
        name: 'Atomic Claims',
        subsystemType: 'service',
        status: 'active',
        contract: 'claim_task() -> lease',
        description: 'Claim handler',
      },
      {
        id: 'sub-2',
        systemId: 'sys-1',
        readableKey: 'sub-vault',
        name: 'Vault',
        subsystemType: 'service',
        status: 'active',
        contract: 'vault_upsert() -> id',
        description: 'Encrypted secrets',
      },
    ],
    position: { x: 20, y: 20 },
  },
  {
    id: 'sys-2',
    universeId: 'u-1',
    universeName: 'Core',
    systemKey: 'remote-mcp',
    name: 'Remote MCP',
    systemType: 'service',
    status: 'active',
    description: 'MCP gateway',
    contextVersion: 1,
    parameters: {},
    functions: [],
    memoriesCount: 1,
    constraintsCount: 0,
    subsystems: [
      {
        id: 'sub-3',
        systemId: 'sys-2',
        readableKey: 'sub-tools',
        name: 'Tool Dispatch',
        subsystemType: 'service',
        status: 'active',
        contract: 'dispatch() -> json',
        description: 'Dispatch tools',
      },
    ],
    position: { x: 460, y: 20 },
  },
];

const FIXTURE_SYSTEM_EDGES: SubstrateSystemEdge[] = [
  {
    id: 'rel-1',
    source: 'sys-1',
    target: 'sys-2',
    relationType: 'integrates_with',
    label: 'integrates_with',
  },
  {
    id: 'wh-1',
    source: 'sys-2',
    target: 'sys-1',
    relationType: 'wormhole',
    label: 'wormhole · bidirectional',
    isWormhole: true,
    syncMode: 'bidirectional',
  },
];

const FIXTURE_VISIONS: VisionGraphNodeData[] = [
  {
    id: 'vision-1',
    readableKey: 'VIS-1',
    title: 'Vision One',
    description: 'First vision',
    targetType: 'system',
    targetLabel: 'core-ledger',
    status: 'active',
    goalsCount: 1,
    position: { x: 20, y: 20 },
  },
  {
    id: 'vision-2',
    readableKey: 'VIS-2',
    title: 'Vision Two',
    description: 'Second vision',
    targetType: 'system',
    targetLabel: 'remote-mcp',
    status: 'planning',
    goalsCount: 0,
    position: { x: 470, y: 20 },
  },
];

const FIXTURE_GOALS: GoalGraphNodeData[] = [
  {
    id: 'goal-1',
    readableKey: 'GOAL-1',
    visionId: 'vision-1',
    title: 'Linked Goal',
    goalType: 'feature',
    priority: 0.9,
    status: 'in_progress',
    blockerNotoriety: 0,
    progress: 50,
    maxIterations: 5,
    currentIteration: 2,
    tasksCount: 2,
    position: { x: 24, y: 112 },
  },
  {
    id: 'goal-standalone',
    readableKey: 'GOAL-2',
    visionId: null,
    title: 'Standalone Goal',
    goalType: 'maintenance',
    priority: 0.6,
    status: 'ready',
    blockerNotoriety: 1,
    progress: 0,
    maxIterations: 3,
    currentIteration: 0,
    tasksCount: 0,
    position: { x: 24, y: 240 },
  },
];

const FIXTURE_TASKS: TaskGraphNodeData[] = [
  {
    id: 'task-1',
    readableKey: 'TASK-1',
    goalId: 'goal-1',
    title: 'First Task',
    taskType: 'implementation',
    status: 'running',
    verificationStatus: 'not_started',
    evalScript: 'npm test',
    inputs: ['schema.sql'],
    outputs: ['result.json'],
    toolsAvailable: ['postgres'],
    contextLimit: { usedTokens: 32000, maxTokens: 128000, windowLabel: '128k tok' },
    checkpoints: [],
    occupancy: {
      agentDisplayLabel: 'Runner · 2026-11-23 06:00:00 UTC · #a1b2c3',
      claimedAt: '2026-11-23T06:00:00.000Z',
      heartbeatAt: '2026-11-23T06:05:00.000Z',
      claimExpiresAt: '2026-11-23T06:20:00.000Z',
      leaseState: 'lease_valid',
      currentStep: 'executing',
      blocker: null,
    },
    blockerNotoriety: 0,
    position: { x: 20, y: 98 },
  },
  {
    id: 'task-2',
    readableKey: 'TASK-2',
    goalId: 'goal-1',
    title: 'Second Task',
    taskType: 'verification',
    status: 'queued',
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
    position: { x: 380, y: 98 },
  },
];

const FIXTURE_VG_EDGES: VisionGoalTaskEdge[] = [
  {
    id: 'gd-1',
    source: 'goal-1',
    target: 'goal-standalone',
    edgeKind: 'goal_dependency',
    dependencyType: 'blocking',
    label: 'blocking',
  },
  {
    id: 'td-1',
    source: 'task-1',
    target: 'task-2',
    edgeKind: 'task_dependency',
    dependencyType: 'blocking',
    label: 'blocking',
  },
];

const FIXTURE_SKILLS: SkillRecord[] = [
  {
    id: 1,
    name: 'Loop Generator',
    slug: 'loop-generator',
    path: 'skills/loop-generator/SKILL.md',
    description: 'Looper skill',
    category: 'Coordination',
    version: '1.0.0',
    status: 'active',
    tools: [{ slug: 'supabase-rpc', type: 'mcp', required: true }],
  },
  {
    id: 2,
    name: 'Security Gate',
    slug: 'security-gate',
    path: 'skills/security-gate/SKILL.md',
    description: 'Audit skill',
    category: 'Security',
    version: '1.2.0',
    status: 'active',
    tools: [{ slug: 'gitleaks', type: 'cli', required: true }],
  },
];

test('buildSystemsGraph handles empty, root, wormhole-filtered, and nested focused system views', () => {
  const empty = buildSystemsGraph({
    systems: [],
    edges: [],
    showWormholes: true,
    focusedSystemId: null,
  });
  assert.equal(empty.nodes.length, 0);
  assert.equal(empty.edges.length, 0);

  const root = buildSystemsGraph({
    systems: FIXTURE_SYSTEMS,
    edges: FIXTURE_SYSTEM_EDGES,
    showWormholes: true,
    focusedSystemId: null,
  });
  assert.equal(root.nodes.length, 2);
  assert.ok(root.nodes.every((n) => n.type === 'systemNode'));
  assert.equal(root.edges.length, 2);

  const withoutWormholes = buildSystemsGraph({
    systems: FIXTURE_SYSTEMS,
    edges: FIXTURE_SYSTEM_EDGES,
    showWormholes: false,
    focusedSystemId: null,
  });
  assert.equal(withoutWormholes.edges.length, 1);

  const insideSys1 = buildSystemsGraph({
    systems: FIXTURE_SYSTEMS,
    edges: FIXTURE_SYSTEM_EDGES,
    showWormholes: true,
    focusedSystemId: 'sys-1',
  });
  assert.equal(insideSys1.nodes.length, 2);
  assert.ok(insideSys1.nodes.every((n) => n.type === 'subsystemNode'));
  assert.equal(insideSys1.edges.length, 0);
});

test('buildVisionsGoalsGraph renders ONLY visions at root and supports 4-level nested drill-down', () => {
  const root = buildVisionsGoalsGraph({
    visions: FIXTURE_VISIONS,
    goals: FIXTURE_GOALS,
    tasks: FIXTURE_TASKS,
    edges: FIXTURE_VG_EDGES,
    scope: { level: 'root' },
  });
  // Root MUST show ONLY Vision nodes (2 explicit + 1 derived fallback for standalone goal), zero goals/tasks
  assert.equal(root.nodes.filter((n) => n.type === 'visionNode').length, 3);
  assert.equal(root.nodes.filter((n) => n.type === 'goalNode').length, 0);
  assert.equal(root.nodes.filter((n) => n.type === 'taskNode').length, 0);
  // Cross-vision dependency derived from goal-1 -> goal-standalone
  assert.equal(root.edges.some((e) => e.source === 'vision-1' && e.target === 'vision-unassigned-goals'), true);

  const insideVision1 = buildVisionsGoalsGraph({
    visions: FIXTURE_VISIONS,
    goals: FIXTURE_GOALS,
    tasks: FIXTURE_TASKS,
    edges: FIXTURE_VG_EDGES,
    scope: { level: 'vision', visionId: 'vision-1' },
  });
  assert.equal(insideVision1.nodes.length, 1);
  assert.equal(insideVision1.nodes[0].id, 'goal-1');
  assert.equal(insideVision1.nodes[0].type, 'goalNode');

  const insideFallbackVision = buildVisionsGoalsGraph({
    visions: FIXTURE_VISIONS,
    goals: FIXTURE_GOALS,
    tasks: FIXTURE_TASKS,
    edges: FIXTURE_VG_EDGES,
    scope: { level: 'vision', visionId: 'vision-unassigned-goals' },
  });
  assert.equal(insideFallbackVision.nodes.length, 1);
  assert.equal(insideFallbackVision.nodes[0].id, 'goal-standalone');

  const insideGoal1 = buildVisionsGoalsGraph({
    visions: FIXTURE_VISIONS,
    goals: FIXTURE_GOALS,
    tasks: FIXTURE_TASKS,
    edges: FIXTURE_VG_EDGES,
    scope: { level: 'goal', goalId: 'goal-1' },
  });
  const taskNodes = insideGoal1.nodes.filter((n) => n.type === 'taskNode');
  assert.equal(taskNodes.length, 2);
  assert.equal(insideGoal1.edges.some((e) => e.id === 'td-1'), true);

  // Task 1 -> Task 2 layered left-to-right
  const t1 = taskNodes.find((n) => n.id === 'task-1')!;
  const t2 = taskNodes.find((n) => n.id === 'task-2')!;
  assert.ok(t2.position.x > t1.position.x);

  // 4th level: focused task scope
  const insideTask1 = buildVisionsGoalsGraph({
    visions: FIXTURE_VISIONS,
    goals: FIXTURE_GOALS,
    tasks: FIXTURE_TASKS,
    edges: FIXTURE_VG_EDGES,
    scope: { level: 'task', taskId: 'task-1' },
  });
  assert.equal(insideTask1.nodes.length, 1);
  assert.equal(insideTask1.nodes[0].id, 'task-1');
});

test('createForceBodies excludes stickyNoteNode and groupBoxNode annotations', () => {
  const bodies = createForceBodies([
    {
      id: 'vision-1',
      type: 'visionNode',
      position: { x: 20, y: 20 },
      style: { width: 356, height: 162 },
      data: {},
    },
    {
      id: 'sticky-1',
      type: 'stickyNoteNode',
      position: { x: 400, y: 40 },
      style: { width: 220, height: 164 },
      data: { disableFloat: true },
    },
    {
      id: 'group-1',
      type: 'groupBoxNode',
      position: { x: 0, y: 0 },
      style: { width: 480, height: 300 },
      data: { disableFloat: true },
    },
  ]);

  assert.equal(bodies.has('vision-1'), true);
  assert.equal(bodies.has('sticky-1'), false);
  assert.equal(bodies.has('group-1'), false);
});

test('stepForceSimulation produces bounded floaty drift for graph nodes', () => {
  const graph = buildVisionsGoalsGraph({
    visions: FIXTURE_VISIONS,
    goals: FIXTURE_GOALS,
    tasks: FIXTURE_TASKS,
    edges: FIXTURE_VG_EDGES,
    scope: { level: 'root' },
  });
  const bodies = createForceBodies(graph.nodes);

  const next = stepForceSimulation(bodies, {
    timeSec: 1.5,
    dtSec: 0.032,
    links: graph.edges.map((e) => ({ source: e.source, target: e.target })),
    amplitude: 4.5,
  });

  const v1Pos = next.get('vision-1')!;
  const v1Orig = graph.nodes.find((n) => n.id === 'vision-1')!.position;
  const dist = Math.hypot(v1Pos.x - v1Orig.x, v1Pos.y - v1Orig.y);
  assert.ok(dist > 0 && dist < 20);
});

test('formatContextUsage calculates clamped percentage and labels', () => {
  const res = formatContextUsage({ usedTokens: 64000, maxTokens: 128000, windowLabel: '128k tok' });
  assert.equal(res.percent, 50);
  assert.equal(res.usedLabel, '64k');
  assert.equal(res.maxLabel, '128k');
});

test('filterSkills filters dynamically by category and search query', () => {
  const coord = filterSkills(FIXTURE_SKILLS, '', 'Coordination');
  assert.equal(coord.length, 1);
  assert.equal(coord[0].slug, 'loop-generator');

  const byTool = filterSkills(FIXTURE_SKILLS, 'gitleaks', 'All');
  assert.equal(byTool.length, 1);
  assert.equal(byTool[0].slug, 'security-gate');
});

test('setForceBodyAnchor and applyUserAnchorsToNodes preserve moved node coordinates', () => {
  const graph = buildSystemsGraph({
    systems: FIXTURE_SYSTEMS,
    edges: FIXTURE_SYSTEM_EDGES,
    showWormholes: true,
    focusedSystemId: null,
  });
  const bodies = createForceBodies(graph.nodes);
  const placed = setForceBodyAnchor(bodies, 'sys-1', 640, 360);
  assert.deepEqual(placed, { x: 640, y: 360 });

  const sys1 = graph.nodes.find((n) => n.id === 'sys-1')!;
  const anchors = new Map([
    [
      'sys-1',
      {
        x: 710,
        y: 440,
        width: Number(sys1.style?.width ?? 300),
        height: Number(sys1.style?.height ?? 124),
        parentId: sys1.parentId,
      },
    ],
  ]);
  const updated = applyUserAnchorsToNodes(graph.nodes, anchors);
  const moved = updated.find((n) => n.id === 'sys-1')!;
  assert.deepEqual(moved.position, { x: 710, y: 440 });
});
