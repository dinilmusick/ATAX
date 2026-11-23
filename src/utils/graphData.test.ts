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

test('buildSystemsGraph handles empty, collapsed, wormhole-filtered, and expanded states', () => {
  const empty = buildSystemsGraph({
    systems: [],
    edges: [],
    showWormholes: true,
    expandedSystemIds: [],
  });
  assert.equal(empty.nodes.length, 0);
  assert.equal(empty.edges.length, 0);

  const collapsed = buildSystemsGraph({
    systems: FIXTURE_SYSTEMS,
    edges: FIXTURE_SYSTEM_EDGES,
    showWormholes: true,
    expandedSystemIds: [],
  });
  assert.equal(collapsed.nodes.length, 2);
  assert.ok(collapsed.nodes.every((n) => n.type === 'systemNode'));
  assert.equal(collapsed.edges.length, 2);

  const withoutWormholes = buildSystemsGraph({
    systems: FIXTURE_SYSTEMS,
    edges: FIXTURE_SYSTEM_EDGES,
    showWormholes: false,
    expandedSystemIds: [],
  });
  assert.equal(withoutWormholes.edges.length, 1);

  const expanded = buildSystemsGraph({
    systems: FIXTURE_SYSTEMS,
    edges: FIXTURE_SYSTEM_EDGES,
    showWormholes: true,
    expandedSystemIds: ['sys-1', 'sys-2'],
  });
  const subNodes = expanded.nodes.filter((n) => n.type === 'subsystemNode');
  assert.equal(subNodes.length, 3);
  assert.ok(subNodes.every((n) => n.parentId === 'sys-1' || n.parentId === 'sys-2'));

  const sys1Idx = expanded.nodes.findIndex((n) => n.id === 'sys-1');
  const firstChildIdx = expanded.nodes.findIndex((n) => n.parentId === 'sys-1');
  assert.ok(sys1Idx >= 0 && firstChildIdx > sys1Idx);
});

test('buildVisionsGoalsGraph renders standalone goals immediately and nests linked goals/tasks on expansion', () => {
  const root = buildVisionsGoalsGraph({
    visions: FIXTURE_VISIONS,
    goals: FIXTURE_GOALS,
    tasks: FIXTURE_TASKS,
    edges: FIXTURE_VG_EDGES,
    expandedVisionIds: [],
    expandedGoalIds: [],
  });
  // Two collapsed visions + one standalone goal
  assert.equal(root.nodes.filter((n) => n.type === 'visionNode').length, 2);
  assert.equal(root.nodes.filter((n) => n.type === 'goalNode').length, 1);
  assert.equal(root.nodes.filter((n) => n.type === 'taskNode').length, 0);

  const withVision1 = buildVisionsGoalsGraph({
    visions: FIXTURE_VISIONS,
    goals: FIXTURE_GOALS,
    tasks: FIXTURE_TASKS,
    edges: FIXTURE_VG_EDGES,
    expandedVisionIds: ['vision-1'],
    expandedGoalIds: [],
  });
  assert.equal(withVision1.nodes.filter((n) => n.type === 'goalNode').length, 2);
  assert.equal(withVision1.edges.some((e) => e.id === 'gd-1'), true);

  const v1 = withVision1.nodes.find((n) => n.id === 'vision-1')!;
  const v2 = withVision1.nodes.find((n) => n.id === 'vision-2')!;
  const v1Width = Number(v1.style?.width ?? 0);
  assert.ok(v2.position.x > v1.position.x + v1Width);

  const withGoal1 = buildVisionsGoalsGraph({
    visions: FIXTURE_VISIONS,
    goals: FIXTURE_GOALS,
    tasks: FIXTURE_TASKS,
    edges: FIXTURE_VG_EDGES,
    expandedVisionIds: ['vision-1'],
    expandedGoalIds: ['goal-1'],
  });
  const taskNodes = withGoal1.nodes.filter((n) => n.type === 'taskNode');
  assert.equal(taskNodes.length, 2);
  assert.ok(taskNodes.every((n) => n.parentId === 'goal-1' && n.extent === 'parent'));
  assert.equal(withGoal1.edges.some((e) => e.id === 'td-1'), true);
});

test('stepForceSimulation produces bounded floaty drift and clamps nested child nodes', () => {
  const graph = buildVisionsGoalsGraph({
    visions: FIXTURE_VISIONS,
    goals: FIXTURE_GOALS,
    tasks: FIXTURE_TASKS,
    edges: FIXTURE_VG_EDGES,
    expandedVisionIds: ['vision-1'],
    expandedGoalIds: ['goal-1'],
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

  const g1 = graph.nodes.find((n) => n.id === 'goal-1')!;
  const t1 = graph.nodes.find((n) => n.id === 'task-1')!;
  const t1Pos = next.get('task-1')!;
  assert.ok(t1Pos.x >= 16);
  assert.ok(t1Pos.x + Number(t1.style?.width) <= Number(g1.style?.width) - 10);
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
    expandedSystemIds: [],
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
        width: Number(sys1.style?.width ?? 310),
        height: Number(sys1.style?.height ?? 56),
        parentId: sys1.parentId,
      },
    ],
  ]);
  const updated = applyUserAnchorsToNodes(graph.nodes, anchors);
  const moved = updated.find((n) => n.id === 'sys-1')!;
  assert.deepEqual(moved.position, { x: 710, y: 440 });
});
