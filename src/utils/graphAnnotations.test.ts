import test from 'node:test';
import assert from 'node:assert/strict';
import {
  appendUniqueCustomEdge,
  createBranchingNode,
  createCustomDomainNode,
  createCustomEdge,
  createGroupingBox,
  createStickyNote,
  DEFAULT_NODE_BODY_COLORS,
  defaultPortLabelsForBranching,
  isPointInsideRect,
  resolveNodeBodyColor,
} from './graphAnnotations';

test('DEFAULT_NODE_BODY_COLORS assigns distinct body colors to each node type', () => {
  const values = Object.values(DEFAULT_NODE_BODY_COLORS);
  assert.equal(new Set(values).size, values.length);
});

test('resolveNodeBodyColor prioritizes per-node override over per-type preference', () => {
  const prefs = {
    byType: { ...DEFAULT_NODE_BODY_COLORS, goal: '#442211' },
    byNodeId: { 'goal-special': '#113355' },
  };
  assert.equal(resolveNodeBodyColor(prefs, 'goal', 'goal-regular'), '#442211');
  assert.equal(resolveNodeBodyColor(prefs, 'goal', 'goal-special'), '#113355');
});

test('createStickyNote and createGroupingBox scaffold scoped items and spatial containment check', () => {
  const note = createStickyNote('visions:root', 120, 80);
  assert.equal(note.scopeKey, 'visions:root');
  assert.equal(note.x, 120);
  assert.equal(note.y, 80);

  const box = createGroupingBox('systems:root', 100, 100, 'Core Cluster');
  assert.equal(box.scopeKey, 'systems:root');
  assert.equal(box.title, 'Core Cluster');
  assert.equal(isPointInsideRect(250, 200, box), true);
  assert.equal(isPointInsideRect(50, 200, box), false);
});

test('createBranchingNode creates all 3 branching logic node types with valid port labels', () => {
  const miso = createBranchingNode('visions:root', 'multi_in_single_out', 40, 60);
  assert.equal(miso.kind, 'multi_in_single_out');
  assert.equal(miso.portCount, 3);
  assert.deepEqual(miso.portLabels, ['In 1', 'In 2', 'In 3']);

  const simo = createBranchingNode('visions:vision:v1', 'single_in_multi_out', 100, 200);
  assert.equal(simo.kind, 'single_in_multi_out');
  assert.deepEqual(simo.portLabels, ['Route A', 'Route B', 'Fallback']);

  const fanOut = createBranchingNode('systems:root', 'fan_out', 300, 150);
  assert.equal(fanOut.kind, 'fan_out');
  assert.deepEqual(fanOut.portLabels, ['Lane 1', 'Lane 2', 'Lane 3']);
  assert.equal(defaultPortLabelsForBranching('fan_out', 4).length, 4);
});

test('createCustomDomainNode scaffolds contextual domain nodes cleanly', () => {
  const goal = createCustomDomainNode('visions:vision:v1', 'goal', 240, 180, 'v1', 2);
  assert.equal(goal.domainKind, 'goal');
  assert.equal(goal.parentId, 'v1');
  assert.equal(goal.readableKey, 'GOAL-NEW-2');
  assert.equal(goal.x, 240);
  assert.equal(goal.y, 180);
});

test('createCustomEdge rejects self-loops and appendUniqueCustomEdge deduplicates identical connections', () => {
  assert.equal(createCustomEdge('visions:root', 'a', 'a'), null);
  const e1 = createCustomEdge('visions:root', 'a', 'b', 'out', 'in');
  const e2 = createCustomEdge('visions:root', 'a', 'b', 'out', 'in');
  const e3 = createCustomEdge('visions:root', 'a', 'b', 'out-1', 'in');
  assert.ok(e1 && e2 && e3);

  let list = appendUniqueCustomEdge([], e1);
  list = appendUniqueCustomEdge(list, e2);
  assert.equal(list.length, 1);
  list = appendUniqueCustomEdge(list, e3);
  assert.equal(list.length, 2);
});
