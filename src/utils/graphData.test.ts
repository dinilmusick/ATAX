import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSystemsGraph,
  buildVisionsGoalsGraph,
  filterSkills,
  formatContextUsage,
  SKILL_CATALOG,
  TASK_NODES,
  VISION_GOAL_TASK_EDGES,
} from './graphData';
import {
  applyUserAnchorsToNodes,
  createForceBodies,
  setForceBodyAnchor,
  stepForceSimulation,
} from './forcePhysics';

test('buildSystemsGraph starts with top-level systems and nests subsystems on expansion', () => {
  const collapsed = buildSystemsGraph({ showWormholes: true, expandedSystemIds: [] });
  assert.equal(collapsed.nodes.length, 6);
  assert.ok(collapsed.nodes.every((n) => n.type === 'systemNode'));

  const withoutWormholes = buildSystemsGraph({ showWormholes: false, expandedSystemIds: [] });
  assert.ok(collapsed.edges.length > withoutWormholes.edges.length);

  const expanded = buildSystemsGraph({
    showWormholes: true,
    expandedSystemIds: ['sys-ledger', 'sys-mcp'],
  });
  const subNodes = expanded.nodes.filter((n) => n.type === 'subsystemNode');
  assert.equal(subNodes.length, 5);
  assert.ok(subNodes.every((n) => n.parentId === 'sys-ledger' || n.parentId === 'sys-mcp'));

  // Parents must appear before children for React Flow subflows
  const ledgerIdx = expanded.nodes.findIndex((n) => n.id === 'sys-ledger');
  const firstChildIdx = expanded.nodes.findIndex((n) => n.parentId === 'sys-ledger');
  assert.ok(ledgerIdx >= 0 && firstChildIdx > ledgerIdx);

  // Cross-system subsystem edge appears when both parents are expanded
  assert.ok(expanded.edges.some((e) => e.id === 'sube-8'));
});

test('buildVisionsGoalsGraph reveals only visions initially, then goals, then tasks via nesting', () => {
  const root = buildVisionsGoalsGraph({ expandedVisionIds: [], expandedGoalIds: [] });
  assert.equal(root.nodes.length, 2);
  assert.ok(root.nodes.every((n) => n.type === 'visionNode'));
  assert.equal(root.edges.length, 1);
  assert.equal(root.edges[0].label, 'conformance_gate');

  const withVision1 = buildVisionsGoalsGraph({
    expandedVisionIds: ['vision-1'],
    expandedGoalIds: [],
  });
  assert.equal(withVision1.nodes.filter((n) => n.type === 'visionNode').length, 2);
  assert.equal(withVision1.nodes.filter((n) => n.type === 'goalNode').length, 2);
  assert.equal(withVision1.nodes.filter((n) => n.type === 'taskNode').length, 0);

  // Second vision must shift right so it never overlaps expanded vision-1
  const v1 = withVision1.nodes.find((n) => n.id === 'vision-1')!;
  const v2 = withVision1.nodes.find((n) => n.id === 'vision-2')!;
  const v1Width = Number(v1.style?.width ?? 0);
  assert.ok(v2.position.x > v1.position.x + v1Width);

  const withGoal1 = buildVisionsGoalsGraph({
    expandedVisionIds: ['vision-1'],
    expandedGoalIds: ['goal-1'],
  });
  const taskNodes = withGoal1.nodes.filter((n) => n.type === 'taskNode');
  assert.equal(taskNodes.length, 2);
  assert.ok(taskNodes.every((n) => n.parentId === 'goal-1' && n.extent === 'parent'));
  assert.ok(withGoal1.edges.some((e) => e.label === 'token_handoff'));
});

test('VISION_GOAL_TASK_EDGES contains only data-flow/dependency edges and no composition edges', () => {
  const labels = new Set(VISION_GOAL_TASK_EDGES.map((e) => e.label));
  assert.equal(labels.has('vision_target'), false);
  assert.equal(labels.has('spawns_socket'), false);
});

test('every task node defines evalScript, inputs, outputs, toolsAvailable, and contextLimit', () => {
  for (const task of TASK_NODES) {
    assert.ok(task.evalScript.length > 0, `task ${task.id} missing evalScript`);
    assert.ok(task.inputs.length > 0, `task ${task.id} missing inputs`);
    assert.ok(task.outputs.length > 0, `task ${task.id} missing outputs`);
    assert.ok(task.toolsAvailable.length > 0, `task ${task.id} missing toolsAvailable`);
    assert.ok(task.contextLimit.maxTokens > 0, `task ${task.id} invalid contextLimit`);
  }
});

test('stepForceSimulation produces bounded floaty drift and clamps nested child nodes', () => {
  const graph = buildVisionsGoalsGraph({
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

  // Nested task remains clamped inside goal-1 container bounds
  const g1 = graph.nodes.find((n) => n.id === 'goal-1')!;
  const t1 = graph.nodes.find((n) => n.id === 'task-1')!;
  const t1Pos = next.get('task-1')!;
  assert.ok(t1Pos.x >= 16);
  assert.ok(t1Pos.x + Number(t1.style?.width) <= Number(g1.style?.width) - 10);
});

test('formatContextUsage calculates clamped percentage and labels', () => {
  const res = formatContextUsage({ usedTokens: 64000, maxTokens: 128000, windowLabel: '128k ctx' });
  assert.equal(res.percent, 50);
  assert.equal(res.usedLabel, '64k');
  assert.equal(res.maxLabel, '128k');
});

test('filterSkills filters by category and search query', () => {
  const coord = filterSkills(SKILL_CATALOG, '', 'Coordination');
  assert.ok(coord.length >= 2);
  assert.ok(coord.every((s) => s.category === 'Coordination'));

  const looper = filterSkills(SKILL_CATALOG, 'looper', 'All');
  assert.equal(looper.length, 1);
  assert.equal(looper[0].slug, 'loop-generator');
});

test('setForceBodyAnchor keeps released node at dropped coordinates across subsequent float steps', () => {
  const graph = buildVisionsGoalsGraph({ expandedVisionIds: [], expandedGoalIds: [] });
  const bodies = createForceBodies(graph.nodes);

  const dropX = 640;
  const dropY = 360;
  const placed = setForceBodyAnchor(bodies, 'vision-1', dropX, dropY);
  assert.deepEqual(placed, { x: dropX, y: dropY });

  let pos = { x: dropX, y: dropY };
  for (let i = 0; i < 40; i++) {
    const next = stepForceSimulation(bodies, {
      timeSec: i * 0.032,
      dtSec: 0.032,
      links: graph.edges.map((e) => ({ source: e.source, target: e.target })),
      amplitude: 4.5,
    });
    pos = next.get('vision-1')!;
  }

  // Node stays floating gently around its new dropped anchor instead of snapping back to (20, 20)
  assert.ok(Math.hypot(pos.x - dropX, pos.y - dropY) < 12);
  assert.ok(Math.hypot(pos.x - 20, pos.y - 20) > 400);
});

test('applyUserAnchorsToNodes preserves moved positions when dimensions and parent match', () => {
  const graph = buildSystemsGraph({ showWormholes: true, expandedSystemIds: [] });
  const sys1 = graph.nodes.find((n) => n.id === 'sys-control-plane')!;
  const anchors = new Map([
    [
      'sys-control-plane',
      {
        x: 710,
        y: 440,
        width: Number(sys1.style?.width ?? 300),
        height: Number(sys1.style?.height ?? 160),
        parentId: sys1.parentId,
      },
    ],
  ]);

  const updated = applyUserAnchorsToNodes(graph.nodes, anchors);
  const moved = updated.find((n) => n.id === 'sys-control-plane')!;
  assert.deepEqual(moved.position, { x: 710, y: 440 });
});

test('graph nodes start in clean compact minimised dimensions', () => {
  const sysGraph = buildSystemsGraph({ showWormholes: true, expandedSystemIds: [] });
  for (const node of sysGraph.nodes) {
    assert.ok(
      Number(node.style?.height) <= 65,
      `expected system node ${node.id} height <= 65, got ${node.style?.height}`
    );
  }

  const vgGraph = buildVisionsGoalsGraph({
    expandedVisionIds: ['vision-1'],
    expandedGoalIds: ['goal-1'],
  });
  const tasks = vgGraph.nodes.filter((n) => n.type === 'taskNode');
  assert.ok(tasks.length > 0);
  for (const task of tasks) {
    assert.ok(
      Number(task.style?.height) <= 65,
      `expected task node ${task.id} height <= 65, got ${task.style?.height}`
    );
  }
});

test('pinning prevents auto-minimise on outside click while unpinned nodes revert to minimised', () => {
  // Simulate NodeDetailContext state transitions
  let expanded = new Set(['task-1', 'task-2']);
  const pinned = new Set(['task-1']); // task-1 is pinned, task-2 is unpinned

  // User clicks outside both nodes (e.g. on canvas background or another element)
  const clickedNodeId: string | undefined = undefined;

  const next = new Set<string>();
  for (const id of expanded) {
    if (pinned.has(id)) {
      next.add(id); // Pinned stays open
      continue;
    }
    if (clickedNodeId === id) {
      next.add(id);
      continue;
    }
    // Unpinned node clicked outside reverts to minimised (deleted from next)
  }
  expanded = next;

  assert.equal(expanded.has('task-1'), true, 'pinned task-1 must remain expanded');
  assert.equal(expanded.has('task-2'), false, 'unpinned task-2 must revert to minimised');
});
