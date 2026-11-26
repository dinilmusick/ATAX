import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createHandler as createRuntimeHandler } from './worker.mjs';
import { getVisualState, resetVisualState } from './visual-store.mjs';

const token = 'test-visual-agent-token-123456';
const tokenSha = createHash('sha256').update(token).digest('hex');
const env = {
  SUPABASE_URL: 'https://vcaerawuwffziufvpbvw.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'dummy-service-role-jwt',
  MCP_SHARED_TOKEN_SHA256: tokenSha,
  MCP_SHARED_SUBJECT: 'visual-mcp-operator',
  MCP_SHARED_SCOPES: 'atax:read atax:write',
  MCP_ALLOWED_ORIGINS: 'https://client.example',
};

function testLedger() {
  return {
    rpc: async (name, params) => {
      if (name === 'agent_context_overview') {
        return {
          visions: [
            {
              id: 'vis-1',
              title: 'Vision Alpha',
              readable_key: 'VIS-ALPHA',
              status: 'active',
              created_at: new Date(Date.now() - 86400000).toISOString(),
              deadline_at: new Date(Date.now() + 86400000 * 5).toISOString(),
            },
          ],
          goals: [
            {
              id: 'goal-1',
              vision_id: 'vis-1',
              title: 'Goal Alpha One',
              readable_key: 'GOAL-1',
              status: 'active',
              created_at: new Date(Date.now() - 86400000).toISOString(),
              deadline_at: new Date(Date.now() + 3600000).toISOString(), // ~1 hr -> orange/red
            },
          ],
          tasks: [],
          systems: [
            {
              id: 'sys-1',
              name: 'Core System',
              system_key: 'core-system',
              status: 'active',
            },
          ],
        };
      }
      return { rpc: name, params };
    },
    skills: async () => [],
    skill: async () => ({}),
    request: async () => [],
  };
}

const handler = createRuntimeHandler(
  async () => new Response('{}'),
  async (e) => ({ ...e, __ledgerDb: testLedger() })
);

async function post(method, params = {}) {
  const res = await handler(
    new Request('https://atax.example/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + token,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    }),
    env
  );
  return res.json();
}

async function callTool(name, args = {}) {
  const res = await post('tools/call', { name, arguments: args });
  return res.result;
}

test('visual MCP tools are registered in tools/list with proper schemas and scopes', async () => {
  const listRes = await post('tools/list');
  const tools = listRes.result.tools;
  const toolNames = new Set(tools.map((t) => t.name));

  const expectedVisualTools = [
    'atax_visual_graph_inspect',
    'atax_visual_branching_node_create',
    'atax_visual_branching_node_update',
    'atax_visual_branching_node_delete',
    'atax_visual_sticky_note_create',
    'atax_visual_sticky_note_update',
    'atax_visual_sticky_note_delete',
    'atax_visual_group_box_create',
    'atax_visual_group_box_update',
    'atax_visual_group_box_delete',
    'atax_visual_edge_create',
    'atax_visual_edge_delete',
    'atax_visual_edge_list',
    'atax_visual_node_position_set',
    'atax_visual_node_position_reset',
    'atax_visual_node_color_set',
    'atax_visual_deadline_set',
    'atax_visual_domain_node_create',
    'atax_visual_domain_node_delete',
    'atax_visual_state_get',
    'atax_visual_state_reset',
  ];

  for (const name of expectedVisualTools) {
    assert.ok(toolNames.has(name), `Expected ${name} in tools/list`);
  }
});

test('visual MCP lifecycle: branching nodes create, update, and delete', async () => {
  resetVisualState('all');

  // 1. Create Fan-Out Fork
  const createFanOut = await callTool('atax_visual_branching_node_create', {
    kind: 'fan_out',
    scope_key: 'root',
    x: 400,
    y: 250,
    title: 'Data Fan-Out',
    rule: 'Parallel Broadcast',
    port_count: 3,
    port_labels: ['Shard A', 'Shard B', 'Shard C'],
  });
  assert.equal(createFanOut.isError, undefined);
  const fanOutNode = createFanOut.structuredContent.result.node;
  assert.equal(fanOutNode.kind, 'fan_out');
  assert.equal(fanOutNode.title, 'Data Fan-Out');
  assert.deepEqual(fanOutNode.portLabels, ['Shard A', 'Shard B', 'Shard C']);

  // 2. Create Multi-In Selector
  const createMiso = await callTool('atax_visual_branching_node_create', {
    kind: 'multi_in_single_out',
    scope_key: 'root',
    x: 800,
    y: 250,
  });
  assert.equal(createMiso.isError, undefined);
  const misoNode = createMiso.structuredContent.result.node;
  assert.equal(misoNode.kind, 'multi_in_single_out');

  // 3. Connect custom flow edge from Fan-Out to Multi-In
  const connectEdge = await callTool('atax_visual_edge_create', {
    scope_key: 'root',
    source: fanOutNode.id,
    target: misoNode.id,
    source_handle: 'out-0',
    target_handle: 'in-0',
    label: 'flow',
  });
  assert.equal(connectEdge.isError, undefined);
  const edge = connectEdge.structuredContent.result.edge;
  assert.equal(edge.source, fanOutNode.id);
  assert.equal(edge.target, misoNode.id);

  // 4. Update Multi-In Selector
  const updateRes = await callTool('atax_visual_branching_node_update', {
    id: misoNode.id,
    title: 'Consensus Funnel',
    rule: 'Majority Vote',
    port_count: 2,
    port_labels: ['Vote 1', 'Vote 2'],
  });
  assert.equal(updateRes.isError, undefined);
  assert.equal(updateRes.structuredContent.result.node.title, 'Consensus Funnel');
  assert.equal(updateRes.structuredContent.result.node.portCount, 2);

  // 5. Delete Fan-Out node -> edge must be cascaded
  const delRes = await callTool('atax_visual_branching_node_delete', {
    id: fanOutNode.id,
  });
  assert.equal(delRes.isError, undefined);
  assert.equal(delRes.structuredContent.result.success, true);
  assert.equal(delRes.structuredContent.result.removedEdgesCount, 1);

  // Verify custom edges list is now empty for root
  const edgeList = await callTool('atax_visual_edge_list', { scope_key: 'root' });
  assert.equal(edgeList.structuredContent.result.edges.length, 0);
});

test('visual MCP lifecycle: sticky notes and grouping boxes', async () => {
  resetVisualState('all');

  // Sticky Note
  const stickyRes = await callTool('atax_visual_sticky_note_create', {
    scope_key: 'systems',
    text: 'Architecture Review Checklist',
    x: 100,
    y: 150,
    color: '#BBF7D0',
  });
  assert.equal(stickyRes.isError, undefined);
  const sticky = stickyRes.structuredContent.result.stickyNote;
  assert.equal(sticky.text, 'Architecture Review Checklist');
  assert.equal(sticky.color, '#BBF7D0');

  const updateSticky = await callTool('atax_visual_sticky_note_update', {
    id: sticky.id,
    text: 'Updated Checklist Content',
    x: 120,
  });
  assert.equal(updateSticky.structuredContent.result.stickyNote.text, 'Updated Checklist Content');
  assert.equal(updateSticky.structuredContent.result.stickyNote.x, 120);

  // Grouping Box
  const groupRes = await callTool('atax_visual_group_box_create', {
    scope_key: 'systems',
    title: 'Core Services Group',
    color: '#38BDF8',
    x: 80,
    y: 100,
    width: 600,
    height: 400,
  });
  assert.equal(groupRes.isError, undefined);
  const group = groupRes.structuredContent.result.groupBox;
  assert.equal(group.title, 'Core Services Group');

  const updateGroup = await callTool('atax_visual_group_box_update', {
    id: group.id,
    title: 'Ingestion Cluster',
  });
  assert.equal(updateGroup.structuredContent.result.groupBox.title, 'Ingestion Cluster');

  // Deletions
  const delSticky = await callTool('atax_visual_sticky_note_delete', { id: sticky.id });
  assert.equal(delSticky.structuredContent.result.success, true);

  const delGroup = await callTool('atax_visual_group_box_delete', { id: group.id });
  assert.equal(delGroup.structuredContent.result.success, true);
});

test('visual MCP layout: positions, node body colors, and deadline overrides', async () => {
  resetVisualState('all');

  // Set node position
  const posRes = await callTool('atax_visual_node_position_set', {
    scope_key: 'root',
    node_id: 'vis-1',
    x: 450,
    y: 320,
  });
  assert.equal(posRes.isError, undefined);
  assert.deepEqual(posRes.structuredContent.result.position, { x: 450, y: 320 });

  // Set node color preference
  const colorRes = await callTool('atax_visual_node_color_set', {
    color: '#0B2A30',
    node_id: 'vis-1',
  });
  assert.equal(colorRes.isError, undefined);
  assert.equal(colorRes.structuredContent.result.nodeColors.byNodeId['vis-1'], '#0B2A30');

  // Set deadline override (10 hours ago start, 1 minute left -> red)
  const deadlineRes = await callTool('atax_visual_deadline_set', {
    node_id: 'vis-1',
    start_at: new Date(Date.now() - 3600000 * 10).toISOString(),
    deadline_at: new Date(Date.now() + 60000).toISOString(),
  });
  assert.equal(deadlineRes.isError, undefined);
  assert.equal(deadlineRes.structuredContent.result.highlightLevel, 'red');

  // Inspect visual graph for root
  const inspectRes = await callTool('atax_visual_graph_inspect', { scope_key: 'root' });
  assert.equal(inspectRes.isError, undefined);
  const graph = inspectRes.structuredContent.result;
  assert.equal(graph.scopeKey, 'root');
  assert.ok(graph.domainNodes.length >= 1);
  const foundNode = graph.domainNodes.find((n) => n.id === 'vis-1');
  assert.ok(foundNode);
  assert.equal(foundNode.customBodyColor, '#0B2A30');
  assert.deepEqual(foundNode.position, { x: 450, y: 320 });

  // Reset position
  const resetPos = await callTool('atax_visual_node_position_reset', {
    scope_key: 'root',
    node_id: 'vis-1',
  });
  assert.equal(resetPos.structuredContent.result.success, true);
});

test('visual MCP custom domain nodes create, inspect, and delete', async () => {
  resetVisualState('all');

  const domainRes = await callTool('atax_visual_domain_node_create', {
    scope_key: 'root',
    domain_kind: 'vision',
    title: 'Autonomous Space Observatory',
    description: 'Orbital imaging and telemetry coordination',
    x: 600,
    y: 180,
  });
  assert.equal(domainRes.isError, undefined);
  const node = domainRes.structuredContent.result.node;
  assert.equal(node.title, 'Autonomous Space Observatory');
  assert.equal(node.domainKind, 'vision');

  const stateRes = await callTool('atax_visual_state_get', {});
  assert.equal(stateRes.structuredContent.result.customDomainNodes.length, 1);

  const delDomain = await callTool('atax_visual_domain_node_delete', { id: node.id });
  assert.equal(delDomain.structuredContent.result.success, true);
});

test('visual MCP resources: atax://visual/state and atax://visual/summary', async () => {
  resetVisualState('all');

  await callTool('atax_visual_sticky_note_create', {
    scope_key: 'root',
    text: 'Note 1',
    x: 100,
    y: 100,
  });

  const stateRead = await post('resources/read', { uri: 'atax://visual/state' });
  assert.equal(stateRead.error, undefined);
  const parsedState = JSON.parse(stateRead.result.contents[0].text);
  assert.equal(parsedState.stickyNotes.length, 1);

  const summaryRead = await post('resources/read', { uri: 'atax://visual/summary' });
  assert.equal(summaryRead.error, undefined);
  const parsedSummary = JSON.parse(summaryRead.result.contents[0].text);
  assert.equal(parsedSummary.stickyNotesCount, 1);
});

test('visual MCP validation: rejects self-loops and invalid kinds', async () => {
  // Self-loop edge creation
  const selfLoop = await callTool('atax_visual_edge_create', {
    scope_key: 'root',
    source: 'same-node',
    target: 'same-node',
  });
  assert.equal(selfLoop.isError, true);

  // Invalid branching kind
  const badKind = await callTool('atax_visual_branching_node_create', {
    kind: 'invalid_kind',
    scope_key: 'root',
    x: 0,
    y: 0,
  });
  assert.equal(badKind.isError, true);
});
