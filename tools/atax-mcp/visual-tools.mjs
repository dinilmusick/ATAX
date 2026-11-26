/**
 * tools/atax-mcp/visual-tools.mjs
 * MCP tools and resources for ATAX Visual Substrate & Control Plane:
 * - Graph Inspection (inspect rendered nodes, calculated deadline urgency, branching configs, connected edges)
 * - Branching Logic Nodes (Multi-In Selector, Single-In Router, Fan-Out Fork)
 * - Canvas Annotations (Sticky Notes, Grouping Boxes)
 * - Custom Directed Flow Connections (edge create, delete, list)
 * - Node Drag Layout Coordinates & Custom Body Colors
 * - Custom Domain Node Authoring
 * - Visual Substrate Resources (atax://visual/state, atax://visual/summary, atax://visual/systems, atax://visual/visions)
 */

import {
  addBranchingNode,
  addCustomDomainNode,
  addCustomEdge,
  addGroupingBox,
  addStickyNote,
  DEFAULT_NODE_BODY_COLORS,
  deleteBranchingNode,
  deleteCustomDomainNode,
  deleteCustomEdge,
  deleteGroupingBox,
  deleteStickyNote,
  getVisualState,
  listCustomEdges,
  resetNodePosition,
  resetVisualState,
  setNodeColor,
  setNodeDeadline,
  setNodePosition,
  updateBranchingNode,
  updateGroupingBox,
  updateStickyNote,
} from './visual-store.mjs';

const one = (description, properties, required = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});

const S = {
  text: (description, maxLength = 256) => ({ type: 'string', description, minLength: 1, maxLength }),
  optText: (description, maxLength = 256) => ({ type: 'string', description, maxLength }),
  json: (description) => ({ description }),
  int: (description, min = -100000, max = 100000) => ({ type: 'integer', minimum: min, maximum: max, description }),
  bool: (description) => ({ type: 'boolean', description }),
};

const tool = (name, description, scope, inputSchema, invoke) => ({
  name,
  description,
  scope,
  inputSchema,
  invoke,
});

function calculateDeadlineHighlight(startAt, deadlineAt, status = 'active') {
  if (['completed', 'finalized', 'verified'].includes(status)) {
    return { level: 'none', strokeColor: '#10B981', label: 'Done' };
  }
  if (!deadlineAt) {
    return { level: 'none', strokeColor: '#DF6B3B', label: 'No deadline' };
  }
  const end = new Date(deadlineAt).getTime();
  const start = startAt ? new Date(startAt).getTime() : end - 86400000 * 7;
  const now = Date.now();
  const total = Math.max(1000, end - start);
  const remaining = end - now;
  if (remaining <= 0) {
    return { level: 'red', strokeColor: '#EF4444', label: 'Overdue' };
  }
  const ratio = remaining / total;
  if (ratio <= 0.05) {
    return { level: 'red', strokeColor: '#EF4444', label: `${Math.round(ratio * 100)}% remaining` };
  }
  if (ratio <= 0.25) {
    return { level: 'orange', strokeColor: '#F97316', label: `${Math.round(ratio * 100)}% remaining` };
  }
  if (ratio <= 0.5) {
    return { level: 'yellow', strokeColor: '#EAB308', label: `${Math.round(ratio * 100)}% remaining` };
  }
  return { level: 'green', strokeColor: '#10B981', label: `${Math.round(ratio * 100)}% remaining` };
}

export const visualTools = [
  // 1. Inspect live visual graph layout, hierarchy, and annotations
  tool(
    'atax_visual_graph_inspect',
    'Inspect visual canvas elements, layout coordinates, deadline highlights, branching nodes, and custom connections for a given scope (e.g. root, systems, vision:<uuid>, goal:<uuid>)',
    'atax:read',
    one('inspect scope', {
      scope_key: S.text('Canvas scope: "root" (Visions), "systems", "vision:<id>", or "goal:<id>"', 120),
    }, ['scope_key']),
    async (args, db) => {
      const scopeKey = args.scope_key;
      const state = getVisualState();
      const scopeBranching = state.branchingNodes.filter((n) => n.scopeKey === scopeKey);
      const scopeSticky = state.stickyNotes.filter((n) => n.scopeKey === scopeKey);
      const scopeGroups = state.groupBoxes.filter((b) => b.scopeKey === scopeKey);
      const scopeCustomNodes = state.customDomainNodes.filter((n) => n.scopeKey === scopeKey);
      const scopeEdges = state.customEdges.filter((e) => e.scopeKey === scopeKey);
      const scopePositions = state.savedPositions[scopeKey] || {};

      let domainNodes = [];
      let domainEdges = [];

      try {
        if (scopeKey === 'root' || scopeKey === 'visions' || scopeKey.startsWith('vision:') || scopeKey.startsWith('goal:')) {
          if (db?.rpc) {
            const overview = await db.rpc('agent_context_overview', {});
            const visions = overview?.visions || overview?.universe?.visions || [];
            const goals = overview?.goals || [];
            const tasks = overview?.tasks || [];

            if (scopeKey === 'root' || scopeKey === 'visions') {
              domainNodes = visions.map((v) => {
                const override = state.deadlineOverrides[v.id];
                const highlight = calculateDeadlineHighlight(
                  override?.startAt || v.created_at,
                  override?.deadlineAt || v.deadline_at,
                  v.status
                );
                return {
                  id: v.id,
                  kind: 'vision',
                  title: v.title,
                  key: v.readable_key || v.key,
                  status: v.status,
                  deadlineHighlight: highlight,
                  customBodyColor: state.nodeColors.byNodeId[v.id] || state.nodeColors.byType.vision,
                  position: scopePositions[v.id] || { x: 260, y: 220 },
                };
              });
            } else if (scopeKey.startsWith('vision:')) {
              const visionId = scopeKey.slice('vision:'.length);
              domainNodes = goals
                .filter((g) => g.vision_id === visionId || g.visionId === visionId)
                .map((g) => {
                  const override = state.deadlineOverrides[g.id];
                  const highlight = calculateDeadlineHighlight(
                    override?.startAt || g.created_at,
                    override?.deadlineAt || g.deadline_at,
                    g.status
                  );
                  return {
                    id: g.id,
                    kind: 'goal',
                    title: g.title,
                    key: g.readable_key || g.key,
                    status: g.status,
                    deadlineHighlight: highlight,
                    customBodyColor: state.nodeColors.byNodeId[g.id] || state.nodeColors.byType.goal,
                    position: scopePositions[g.id] || { x: 260, y: 220 },
                  };
                });
            } else if (scopeKey.startsWith('goal:')) {
              const goalId = scopeKey.slice('goal:'.length);
              domainNodes = tasks
                .filter((t) => t.goal_id === goalId || t.goalId === goalId)
                .map((t) => {
                  const override = state.deadlineOverrides[t.id];
                  const highlight = calculateDeadlineHighlight(
                    override?.startAt || t.created_at,
                    override?.deadlineAt || t.due_at,
                    t.status
                  );
                  return {
                    id: t.id,
                    kind: 'task',
                    title: t.title,
                    key: t.readable_key || t.key,
                    status: t.status,
                    deadlineHighlight: highlight,
                    customBodyColor: state.nodeColors.byNodeId[t.id] || state.nodeColors.byType.task,
                    position: scopePositions[t.id] || { x: 260, y: 220 },
                  };
                });
            }
          }
        } else if (scopeKey === 'systems' || scopeKey.startsWith('system:')) {
          if (db?.rpc) {
            const overview = await db.rpc('agent_context_overview', {});
            const systems = overview?.systems || [];
            domainNodes = systems.map((s) => ({
              id: s.id || s.system_key,
              kind: 'system',
              title: s.name || s.title || s.system_key,
              key: s.system_key,
              status: s.status || 'active',
              customBodyColor: state.nodeColors.byNodeId[s.id || s.system_key] || state.nodeColors.byType.system,
              position: scopePositions[s.id || s.system_key] || { x: 260, y: 220 },
            }));
          }
        }
      } catch {
        // Fallback: continue with visual state elements if substrate rpc is unavailable
      }

      return {
        scopeKey,
        domainNodes: [...domainNodes, ...scopeCustomNodes],
        branchingNodes: scopeBranching,
        stickyNotes: scopeSticky,
        groupBoxes: scopeGroups,
        customEdges: scopeEdges,
        savedPositions: scopePositions,
        nodeColorPreferences: state.nodeColors,
        counts: {
          domainNodes: domainNodes.length + scopeCustomNodes.length,
          branchingNodes: scopeBranching.length,
          stickyNotes: scopeSticky.length,
          groupBoxes: scopeGroups.length,
          customEdges: scopeEdges.length,
        },
      };
    }
  ),

  // 2. Branching node creation
  tool(
    'atax_visual_branching_node_create',
    'Create a visual branching logic node: multi_in_single_out selector (funnel), single_in_multi_out router (prism), or fan_out fork (parallel broadcast manifold)',
    'atax:write',
    one('create branching node', {
      kind: {
        type: 'string',
        enum: ['multi_in_single_out', 'single_in_multi_out', 'fan_out'],
        description: 'Branching node archetype',
      },
      scope_key: S.text('Target canvas scope (e.g. "root", "systems", "vision:<id>", "goal:<id>")', 120),
      x: S.int('Canvas X coordinate', -100000, 100000),
      y: S.int('Canvas Y coordinate', -100000, 100000),
      title: S.optText('Custom title label', 100),
      rule: S.optText('Logic rule (e.g. "First Ready", "Condition Match", "Parallel Broadcast")', 100),
      description: S.optText('Brief description of the branching function', 256),
      port_count: {
        type: 'integer',
        minimum: 2,
        maximum: 4,
        description: 'Number of dynamic ports (2 to 4)',
      },
      port_labels: {
        type: 'array',
        items: S.text('Port handle label', 40),
        maxItems: 4,
        description: 'Optional custom labels for each dynamic port handle',
      },
    }, ['kind', 'scope_key', 'x', 'y']),
    async (args) => {
      const created = addBranchingNode({
        kind: args.kind,
        scopeKey: args.scope_key,
        x: args.x,
        y: args.y,
        title: args.title,
        rule: args.rule,
        description: args.description,
        portCount: args.port_count,
        portLabels: args.port_labels,
      });
      return { success: true, node: created };
    }
  ),

  // 3. Branching node update
  tool(
    'atax_visual_branching_node_update',
    'Update an existing branching logic node title, rule, port count, port labels, or coordinates',
    'atax:write',
    one('update branching node', {
      id: S.text('Branching node ID', 120),
      title: S.optText('Updated title', 100),
      rule: S.optText('Updated logic rule', 100),
      description: S.optText('Updated description', 256),
      port_count: {
        type: 'integer',
        minimum: 2,
        maximum: 4,
        description: 'Updated port count (2 to 4)',
      },
      port_labels: {
        type: 'array',
        items: S.text('Port handle label', 40),
        maxItems: 4,
        description: 'Updated port labels',
      },
      x: { type: 'integer', minimum: -100000, maximum: 100000, description: 'Updated X coordinate' },
      y: { type: 'integer', minimum: -100000, maximum: 100000, description: 'Updated Y coordinate' },
    }, ['id']),
    async (args) => {
      const updated = updateBranchingNode(args.id, {
        title: args.title,
        rule: args.rule,
        description: args.description,
        portCount: args.port_count,
        portLabels: args.port_labels,
        x: args.x,
        y: args.y,
      });
      return { success: true, node: updated };
    }
  ),

  // 4. Branching node delete
  tool(
    'atax_visual_branching_node_delete',
    'Delete a visual branching logic node and any incident custom edges',
    'atax:write',
    one('delete branching node', {
      id: S.text('Branching node ID to remove', 120),
    }, ['id']),
    async (args) => {
      return deleteBranchingNode(args.id);
    }
  ),

  // 5. Sticky note create
  tool(
    'atax_visual_sticky_note_create',
    'Create a visual sticky note on the canvas with text, color, and coordinates',
    'atax:write',
    one('create sticky note', {
      scope_key: S.text('Canvas scope (e.g. "root", "systems", "vision:<id>", "goal:<id>")', 120),
      text: { type: 'string', description: 'Note markdown content', maxLength: 4000 },
      x: S.int('Canvas X coordinate', -100000, 100000),
      y: S.int('Canvas Y coordinate', -100000, 100000),
      color: S.optText('Color hex (e.g. #FEF08A Canary, #BBF7D0 Mint, #BAE6FD Sky, #FED7AA Peach, #FECDD3 Rose)', 32),
      width: { type: 'integer', minimum: 120, maximum: 1200, description: 'Note width in pixels' },
      height: { type: 'integer', minimum: 80, maximum: 1200, description: 'Note height in pixels' },
    }, ['scope_key', 'text', 'x', 'y']),
    async (args) => {
      const created = addStickyNote({
        scopeKey: args.scope_key,
        text: args.text,
        x: args.x,
        y: args.y,
        color: args.color,
        width: args.width,
        height: args.height,
      });
      return { success: true, stickyNote: created };
    }
  ),

  // 6. Sticky note update
  tool(
    'atax_visual_sticky_note_update',
    'Update text, color, position, or dimensions of an existing visual sticky note',
    'atax:write',
    one('update sticky note', {
      id: S.text('Sticky note ID', 120),
      text: { type: 'string', description: 'Updated text content', maxLength: 4000 },
      color: S.optText('Updated color hex', 32),
      x: { type: 'integer', minimum: -100000, maximum: 100000, description: 'Updated X coordinate' },
      y: { type: 'integer', minimum: -100000, maximum: 100000, description: 'Updated Y coordinate' },
      width: { type: 'integer', minimum: 120, maximum: 1200, description: 'Updated width' },
      height: { type: 'integer', minimum: 80, maximum: 1200, description: 'Updated height' },
    }, ['id']),
    async (args) => {
      const updated = updateStickyNote(args.id, args);
      return { success: true, stickyNote: updated };
    }
  ),

  // 7. Sticky note delete
  tool(
    'atax_visual_sticky_note_delete',
    'Delete a visual sticky note from the canvas',
    'atax:write',
    one('delete sticky note', {
      id: S.text('Sticky note ID to delete', 120),
    }, ['id']),
    async (args) => {
      return deleteStickyNote(args.id);
    }
  ),

  // 8. Grouping box create
  tool(
    'atax_visual_group_box_create',
    'Create a visual grouping box to enclose and organize nodes on the canvas',
    'atax:write',
    one('create grouping box', {
      scope_key: S.text('Canvas scope (e.g. "root", "systems", "vision:<id>", "goal:<id>")', 120),
      title: S.text('Grouping box title header', 100),
      color: S.optText('Color hex (e.g. #E04819 Terracotta, #10B981 Emerald, #F59E0B Amber, #38BDF8 Cobalt, #A78BFA Violet)', 32),
      x: S.int('Canvas top-left X coordinate', -100000, 100000),
      y: S.int('Canvas top-left Y coordinate', -100000, 100000),
      width: { type: 'integer', minimum: 200, maximum: 4000, description: 'Box width in pixels' },
      height: { type: 'integer', minimum: 150, maximum: 4000, description: 'Box height in pixels' },
    }, ['scope_key', 'title', 'x', 'y']),
    async (args) => {
      const created = addGroupingBox({
        scopeKey: args.scope_key,
        title: args.title,
        color: args.color,
        x: args.x,
        y: args.y,
        width: args.width,
        height: args.height,
      });
      return { success: true, groupBox: created };
    }
  ),

  // 9. Grouping box update
  tool(
    'atax_visual_group_box_update',
    'Update title, color, position, or dimensions of an existing visual grouping box',
    'atax:write',
    one('update grouping box', {
      id: S.text('Grouping box ID', 120),
      title: S.optText('Updated title', 100),
      color: S.optText('Updated color hex', 32),
      x: { type: 'integer', minimum: -100000, maximum: 100000, description: 'Updated X coordinate' },
      y: { type: 'integer', minimum: -100000, maximum: 100000, description: 'Updated Y coordinate' },
      width: { type: 'integer', minimum: 200, maximum: 4000, description: 'Updated width' },
      height: { type: 'integer', minimum: 150, maximum: 4000, description: 'Updated height' },
    }, ['id']),
    async (args) => {
      const updated = updateGroupingBox(args.id, args);
      return { success: true, groupBox: updated };
    }
  ),

  // 10. Grouping box delete
  tool(
    'atax_visual_group_box_delete',
    'Delete a visual grouping box from the canvas',
    'atax:write',
    one('delete grouping box', {
      id: S.text('Grouping box ID to delete', 120),
    }, ['id']),
    async (args) => {
      return deleteGroupingBox(args.id);
    }
  ),

  // 11. Custom flow edge create
  tool(
    'atax_visual_edge_create',
    'Connect a directed visual flow edge between handles of two nodes on the canvas (supports visions, goals, tasks, systems, subsystems, and branching logic nodes)',
    'atax:write',
    one('create flow edge', {
      scope_key: S.text('Canvas scope (e.g. "root", "systems", "vision:<id>", "goal:<id>")', 120),
      source: S.text('Source node ID', 120),
      target: S.text('Target node ID', 120),
      source_handle: S.optText('Source handle ID (e.g. "out", "out-0", "out-1", "s-right")', 60),
      target_handle: S.optText('Target handle ID (e.g. "in", "in-0", "in-1", "t-left")', 60),
      label: S.optText('Edge label (defaults to "flow")', 60),
    }, ['scope_key', 'source', 'target']),
    async (args) => {
      const created = addCustomEdge({
        scopeKey: args.scope_key,
        source: args.source,
        target: args.target,
        sourceHandle: args.source_handle,
        targetHandle: args.target_handle,
        label: args.label,
      });
      return { success: true, edge: created };
    }
  ),

  // 12. Custom flow edge delete
  tool(
    'atax_visual_edge_delete',
    'Delete a custom visual flow edge connection by edge ID',
    'atax:write',
    one('delete flow edge', {
      id: S.text('Custom edge ID to remove', 120),
    }, ['id']),
    async (args) => {
      return deleteCustomEdge(args.id);
    }
  ),

  // 13. Custom flow edge list
  tool(
    'atax_visual_edge_list',
    'List all custom visual flow edges, optionally filtered by canvas scope',
    'atax:read',
    one('list flow edges', {
      scope_key: S.optText('Optional scope filter (e.g. "root", "systems", "vision:<id>")', 120),
    }),
    async (args) => {
      const edges = listCustomEdges(args.scope_key);
      return { edges, count: edges.length };
    }
  ),

  // 14. Node position set
  tool(
    'atax_visual_node_position_set',
    'Persist custom canvas coordinates for any node (visions, goals, tasks, systems, subsystems, or custom nodes), controlling exact spatial layout',
    'atax:write',
    one('set node position', {
      scope_key: S.text('Canvas scope (e.g. "root", "systems", "vision:<id>", "goal:<id>")', 120),
      node_id: S.text('Node ID to position', 120),
      x: S.int('Canvas X coordinate', -100000, 100000),
      y: S.int('Canvas Y coordinate', -100000, 100000),
    }, ['scope_key', 'node_id', 'x', 'y']),
    async (args) => {
      return setNodePosition(args.scope_key, args.node_id, { x: args.x, y: args.y });
    }
  ),

  // 15. Node position reset
  tool(
    'atax_visual_node_position_reset',
    'Reset a node position back to automatic layout coordinates',
    'atax:write',
    one('reset node position', {
      scope_key: S.text('Canvas scope', 120),
      node_id: S.text('Node ID to reset', 120),
    }, ['scope_key', 'node_id']),
    async (args) => {
      return resetNodePosition(args.scope_key, args.node_id);
    }
  ),

  // 16. Node body color set
  tool(
    'atax_visual_node_color_set',
    'Set custom body color for an individual node or globally for a node archetype',
    'atax:write',
    one('set node color', {
      color: S.text('Hex color code (e.g. "#0B2A30")', 32),
      node_id: S.optText('Specific node ID override (if omitted, sets type preference)', 120),
      node_type: {
        type: 'string',
        enum: ['vision', 'goal', 'task', 'system', 'subsystem', 'multi_in_single_out', 'single_in_multi_out', 'fan_out'],
        description: 'Target archetype if setting type preference',
      },
    }, ['color']),
    async (args) => {
      const updated = setNodeColor(args.color, args.node_id, args.node_type);
      return { success: true, nodeColors: updated };
    }
  ),

  // 17. Node deadline override set
  tool(
    'atax_visual_deadline_set',
    'Set a deadline override on a node to update real-time urgency highlight (green: >50% remaining, yellow: 25-50%, orange: 5-25%, red: <=5% or overdue)',
    'atax:write',
    one('set node deadline', {
      node_id: S.text('Target node ID', 120),
      deadline_at: S.text('ISO timestamp for deadline completion', 60),
      start_at: S.optText('Optional ISO timestamp for start time (defaults to now)', 60),
    }, ['node_id', 'deadline_at']),
    async (args) => {
      const record = setNodeDeadline(args.node_id, args.deadline_at, args.start_at);
      const highlight = calculateDeadlineHighlight(record.startAt, record.deadlineAt);
      return { success: true, ...record, highlightLevel: highlight.level, highlightLabel: highlight.label };
    }
  ),

  // 18. Custom domain node create
  tool(
    'atax_visual_domain_node_create',
    'Create a custom domain node (vision, goal, task, system, or subsystem) on the canvas',
    'atax:write',
    one('create domain node', {
      scope_key: S.text('Canvas scope', 120),
      domain_kind: {
        type: 'string',
        enum: ['vision', 'goal', 'task', 'system', 'subsystem'],
        description: 'Domain node kind',
      },
      title: S.text('Node title', 120),
      description: S.optText('Node description', 512),
      x: S.int('Canvas X coordinate', -100000, 100000),
      y: S.int('Canvas Y coordinate', -100000, 100000),
      parent_id: S.optText('Optional parent ID (e.g. Vision UUID for a Goal)', 120),
      readable_key: S.optText('Optional readable key', 60),
    }, ['scope_key', 'domain_kind', 'title', 'x', 'y']),
    async (args) => {
      const created = addCustomDomainNode({
        scopeKey: args.scope_key,
        domainKind: args.domain_kind,
        title: args.title,
        description: args.description,
        x: args.x,
        y: args.y,
        parentId: args.parent_id,
        readableKey: args.readable_key,
      });
      return { success: true, node: created };
    }
  ),

  // 19. Custom domain node delete
  tool(
    'atax_visual_domain_node_delete',
    'Delete a custom domain node and any connected custom flow edges',
    'atax:write',
    one('delete domain node', {
      id: S.text('Custom domain node ID to delete', 120),
    }, ['id']),
    async (args) => {
      return deleteCustomDomainNode(args.id);
    }
  ),

  // 20. Full visual state retrieve
  tool(
    'atax_visual_state_get',
    'Retrieve the entire visual substrate state including all sticky notes, grouping boxes, branching nodes, custom edges, positions, node colors, and deadline overrides',
    'atax:read',
    one('get visual state', {}),
    async () => {
      return getVisualState();
    }
  ),

  // 21. Reset visual state
  tool(
    'atax_visual_state_reset',
    'Reset visual state elements (annotations, branching nodes, custom edges, positions, or colors), optionally scoped',
    'atax:write',
    one('reset visual state', {
      target: {
        type: 'string',
        enum: ['all', 'annotations', 'branching_nodes', 'custom_edges', 'positions', 'colors'],
        description: 'What portion of visual state to reset',
      },
      scope_key: S.optText('Optional canvas scope key filter', 120),
    }),
    async (args) => {
      return resetVisualState(args.target || 'all', args.scope_key);
    }
  ),
];

export const visualResourceDefs = [
  {
    uri: 'atax://visual/state',
    name: 'Visual substrate configuration state',
    mimeType: 'application/json',
    description: 'Complete visual layout, annotations, branching logic, custom edges, and styling',
  },
  {
    uri: 'atax://visual/summary',
    name: 'Visual substrate summary overview',
    mimeType: 'application/json',
    description: 'Counts and summaries of active visual flows, branching decisions, notes, and groups',
  },
];
