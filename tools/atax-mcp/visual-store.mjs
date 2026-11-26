/**
 * tools/atax-mcp/visual-store.mjs
 * Persistent in-memory and disk-backed store for visual substrate state:
 * - Annotations: Sticky Notes, Grouping Boxes
 * - Branching Logic: Multi-In Selector, Single-In Router, Fan-Out Fork
 * - Custom Flow Edges: handle-to-handle directed connections
 * - Custom Domain Nodes: Visions, Goals, Tasks, Systems, Subsystems
 * - Node Layout Coordinates & Body Color Preferences
 * - Deadline Urgency Overrides
 * Zero external npm runtime dependencies. Works in Node.js and Worker environments.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export const DEFAULT_NODE_BODY_COLORS = Object.freeze({
  vision: '#0A2920',
  goal: '#2E1A05',
  task: '#0D1E36',
  system: '#24130E',
  subsystem: '#1E1233',
  multi_in_single_out: '#0B2A30',
  single_in_multi_out: '#331016',
  fan_out: '#162712',
});

function defaultState() {
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    stickyNotes: [],
    groupBoxes: [],
    branchingNodes: [],
    customDomainNodes: [],
    customEdges: [],
    savedPositions: {},
    nodeColors: {
      byType: { ...DEFAULT_NODE_BODY_COLORS },
      byNodeId: {},
    },
    deadlineOverrides: {},
  };
}

let storeState = defaultState();
let storeFilePath = null;

function resolveStorePath() {
  if (storeFilePath) return storeFilePath;
  try {
    const cwd = process.cwd ? process.cwd() : '.';
    storeFilePath = resolve(cwd, '.data', 'visual-substrate-store.json');
    return storeFilePath;
  } catch {
    return null;
  }
}

export function loadStoreFromDisk() {
  const file = resolveStorePath();
  if (!file) return storeState;
  try {
    if (existsSync(file)) {
      const raw = readFileSync(file, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        storeState = {
          ...defaultState(),
          ...parsed,
          nodeColors: {
            byType: { ...DEFAULT_NODE_BODY_COLORS, ...(parsed.nodeColors?.byType || {}) },
            byNodeId: { ...(parsed.nodeColors?.byNodeId || {}) },
          },
        };
      }
    }
  } catch (err) {
    console.warn('[visual-store] Error loading store from disk:', err?.message || err);
  }
  return storeState;
}

export function saveStoreToDisk() {
  const file = resolveStorePath();
  if (!file) return;
  try {
    const dir = dirname(file);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    storeState.updatedAt = new Date().toISOString();
    writeFileSync(file, JSON.stringify(storeState, null, 2), 'utf8');
  } catch (err) {
    // In environments with read-only filesystem (e.g. Cloudflare Worker), ignore disk write
  }
}

// Initialize on module load
loadStoreFromDisk();

export function getVisualState() {
  return JSON.parse(JSON.stringify(storeState));
}

export function setVisualState(incoming) {
  if (!incoming || typeof incoming !== 'object') return getVisualState();
  storeState = {
    ...storeState,
    stickyNotes: Array.isArray(incoming.stickyNotes) ? incoming.stickyNotes : storeState.stickyNotes,
    groupBoxes: Array.isArray(incoming.groupBoxes) ? incoming.groupBoxes : storeState.groupBoxes,
    branchingNodes: Array.isArray(incoming.branchingNodes) ? incoming.branchingNodes : storeState.branchingNodes,
    customDomainNodes: Array.isArray(incoming.customDomainNodes) ? incoming.customDomainNodes : storeState.customDomainNodes,
    customEdges: Array.isArray(incoming.customEdges) ? incoming.customEdges : storeState.customEdges,
    savedPositions: incoming.savedPositions && typeof incoming.savedPositions === 'object' ? incoming.savedPositions : storeState.savedPositions,
    nodeColors: incoming.nodeColors && typeof incoming.nodeColors === 'object' ? {
      byType: { ...DEFAULT_NODE_BODY_COLORS, ...(incoming.nodeColors.byType || {}) },
      byNodeId: { ...(incoming.nodeColors.byNodeId || {}) },
    } : storeState.nodeColors,
    deadlineOverrides: incoming.deadlineOverrides && typeof incoming.deadlineOverrides === 'object' ? incoming.deadlineOverrides : storeState.deadlineOverrides,
    updatedAt: new Date().toISOString(),
  };
  saveStoreToDisk();
  return getVisualState();
}

// ---------------- STICKY NOTES ----------------

export function addStickyNote(item) {
  const id = item.id || `sticky-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const record = {
    id,
    scopeKey: item.scopeKey || 'root',
    text: item.text || '',
    color: item.color || '#FEF08A',
    x: Math.round(item.x ?? 200),
    y: Math.round(item.y ?? 200),
    width: Math.round(item.width ?? 220),
    height: Math.round(item.height ?? 164),
  };
  storeState.stickyNotes = [...storeState.stickyNotes.filter((n) => n.id !== id), record];
  saveStoreToDisk();
  return record;
}

export function updateStickyNote(id, patch) {
  const idx = storeState.stickyNotes.findIndex((n) => n.id === id);
  if (idx < 0) throw new Error(`Sticky note not found: ${id}`);
  const existing = storeState.stickyNotes[idx];
  const updated = {
    ...existing,
    ...(patch.text !== undefined ? { text: String(patch.text) } : {}),
    ...(patch.color ? { color: String(patch.color) } : {}),
    ...(patch.x !== undefined ? { x: Math.round(patch.x) } : {}),
    ...(patch.y !== undefined ? { y: Math.round(patch.y) } : {}),
    ...(patch.width !== undefined ? { width: Math.round(patch.width) } : {}),
    ...(patch.height !== undefined ? { height: Math.round(patch.height) } : {}),
  };
  storeState.stickyNotes[idx] = updated;
  saveStoreToDisk();
  return updated;
}

export function deleteStickyNote(id) {
  const before = storeState.stickyNotes.length;
  storeState.stickyNotes = storeState.stickyNotes.filter((n) => n.id !== id);
  saveStoreToDisk();
  return { success: true, id, deleted: storeState.stickyNotes.length < before };
}

// ---------------- GROUPING BOXES ----------------

export function addGroupingBox(item) {
  const id = item.id || `group-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const record = {
    id,
    scopeKey: item.scopeKey || 'root',
    title: item.title || 'Group',
    color: item.color || '#E04819',
    x: Math.round(item.x ?? 200),
    y: Math.round(item.y ?? 200),
    width: Math.round(item.width ?? 480),
    height: Math.round(item.height ?? 300),
  };
  storeState.groupBoxes = [...storeState.groupBoxes.filter((b) => b.id !== id), record];
  saveStoreToDisk();
  return record;
}

export function updateGroupingBox(id, patch) {
  const idx = storeState.groupBoxes.findIndex((b) => b.id === id);
  if (idx < 0) throw new Error(`Grouping box not found: ${id}`);
  const existing = storeState.groupBoxes[idx];
  const updated = {
    ...existing,
    ...(patch.title !== undefined ? { title: String(patch.title) } : {}),
    ...(patch.color ? { color: String(patch.color) } : {}),
    ...(patch.x !== undefined ? { x: Math.round(patch.x) } : {}),
    ...(patch.y !== undefined ? { y: Math.round(patch.y) } : {}),
    ...(patch.width !== undefined ? { width: Math.round(patch.width) } : {}),
    ...(patch.height !== undefined ? { height: Math.round(patch.height) } : {}),
  };
  storeState.groupBoxes[idx] = updated;
  saveStoreToDisk();
  return updated;
}

export function deleteGroupingBox(id) {
  const before = storeState.groupBoxes.length;
  storeState.groupBoxes = storeState.groupBoxes.filter((b) => b.id !== id);
  saveStoreToDisk();
  return { success: true, id, deleted: storeState.groupBoxes.length < before };
}

// ---------------- BRANCHING NODES ----------------

export function defaultPortLabelsForKind(kind, count) {
  const portCount = Math.min(4, Math.max(2, Math.round(count || 3)));
  if (kind === 'multi_in_single_out') {
    return Array.from({ length: portCount }, (_, i) => `In ${i + 1}`);
  }
  if (kind === 'single_in_multi_out') {
    const defaultNames = ['Route A', 'Route B', 'Fallback', 'Escalation'];
    return Array.from({ length: portCount }, (_, i) => defaultNames[i] || `Out ${i + 1}`);
  }
  return Array.from({ length: portCount }, (_, i) => `Lane ${i + 1}`);
}

export function addBranchingNode(item) {
  const kind = item.kind;
  if (!['multi_in_single_out', 'single_in_multi_out', 'fan_out'].includes(kind)) {
    throw new Error(`Invalid branching node kind: ${kind}`);
  }
  const id = item.id || `branch-${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const portCount = Math.min(4, Math.max(2, Math.round(item.portCount ?? 3)));
  const meta = {
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
  }[kind];

  const record = {
    id,
    scopeKey: item.scopeKey || 'root',
    kind,
    title: item.title || meta.title,
    rule: item.rule || meta.rule,
    description: item.description || meta.description,
    portCount,
    portLabels: Array.isArray(item.portLabels) && item.portLabels.length > 0
      ? item.portLabels.slice(0, portCount)
      : defaultPortLabelsForKind(kind, portCount),
    x: Math.round(item.x ?? 300),
    y: Math.round(item.y ?? 300),
  };

  storeState.branchingNodes = [...storeState.branchingNodes.filter((n) => n.id !== id), record];
  saveStoreToDisk();
  return record;
}

export function updateBranchingNode(id, patch) {
  const idx = storeState.branchingNodes.findIndex((n) => n.id === id);
  if (idx < 0) throw new Error(`Branching node not found: ${id}`);
  const existing = storeState.branchingNodes[idx];
  const portCount = patch.portCount !== undefined
    ? Math.min(4, Math.max(2, Math.round(patch.portCount)))
    : existing.portCount;

  let portLabels = existing.portLabels;
  if (Array.isArray(patch.portLabels)) {
    portLabels = patch.portLabels.slice(0, portCount);
  } else if (portCount !== existing.portCount) {
    portLabels = defaultPortLabelsForKind(existing.kind, portCount);
  }

  const updated = {
    ...existing,
    ...(patch.title !== undefined ? { title: String(patch.title) } : {}),
    ...(patch.rule !== undefined ? { rule: String(patch.rule) } : {}),
    ...(patch.description !== undefined ? { description: String(patch.description) } : {}),
    portCount,
    portLabels,
    ...(patch.x !== undefined ? { x: Math.round(patch.x) } : {}),
    ...(patch.y !== undefined ? { y: Math.round(patch.y) } : {}),
  };
  storeState.branchingNodes[idx] = updated;
  saveStoreToDisk();
  return updated;
}

export function deleteBranchingNode(id) {
  const beforeNodes = storeState.branchingNodes.length;
  storeState.branchingNodes = storeState.branchingNodes.filter((n) => n.id !== id);
  // Also clean up any custom edges connected to this node
  const beforeEdges = storeState.customEdges.length;
  storeState.customEdges = storeState.customEdges.filter(
    (e) => e.source !== id && e.target !== id
  );
  saveStoreToDisk();
  return {
    success: true,
    id,
    deleted: storeState.branchingNodes.length < beforeNodes,
    removedEdgesCount: beforeEdges - storeState.customEdges.length,
  };
}

// ---------------- CUSTOM DOMAIN NODES ----------------

export function addCustomDomainNode(item) {
  const domainKind = item.domainKind;
  if (!['vision', 'goal', 'task', 'system', 'subsystem'].includes(domainKind)) {
    throw new Error(`Invalid custom domain kind: ${domainKind}`);
  }
  const id = item.id || `custom-${domainKind}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const record = {
    id,
    scopeKey: item.scopeKey || 'root',
    domainKind,
    parentId: item.parentId || null,
    readableKey: item.readableKey || `${domainKind.toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
    title: item.title || `Custom ${domainKind.charAt(0).toUpperCase() + domainKind.slice(1)}`,
    description: item.description || 'User-created custom flow node.',
    status: item.status || 'active',
    subtitle: domainKind === 'system' || domainKind === 'subsystem' ? 'service' : 'flow',
    x: Math.round(item.x ?? 300),
    y: Math.round(item.y ?? 300),
  };
  storeState.customDomainNodes = [...storeState.customDomainNodes.filter((n) => n.id !== id), record];
  saveStoreToDisk();
  return record;
}

export function deleteCustomDomainNode(id) {
  const beforeNodes = storeState.customDomainNodes.length;
  storeState.customDomainNodes = storeState.customDomainNodes.filter((n) => n.id !== id);
  const beforeEdges = storeState.customEdges.length;
  storeState.customEdges = storeState.customEdges.filter(
    (e) => e.source !== id && e.target !== id
  );
  saveStoreToDisk();
  return {
    success: true,
    id,
    deleted: storeState.customDomainNodes.length < beforeNodes,
    removedEdgesCount: beforeEdges - storeState.customEdges.length,
  };
}

// ---------------- CUSTOM EDGES ----------------

export function addCustomEdge(edge) {
  if (!edge || !edge.source || !edge.target) {
    throw new Error('Edge requires source and target node IDs');
  }
  if (edge.source === edge.target) {
    throw new Error('Self-loop edges are not permitted');
  }
  const scopeKey = edge.scopeKey || 'root';
  const sourceHandle = edge.sourceHandle ?? null;
  const targetHandle = edge.targetHandle ?? null;

  // Deduplicate
  const exists = storeState.customEdges.some(
    (e) =>
      e.scopeKey === scopeKey &&
      e.source === edge.source &&
      e.target === edge.target &&
      (e.sourceHandle || null) === sourceHandle &&
      (e.targetHandle || null) === targetHandle
  );
  if (exists) {
    return storeState.customEdges.find(
      (e) =>
        e.scopeKey === scopeKey &&
        e.source === edge.source &&
        e.target === edge.target &&
        (e.sourceHandle || null) === sourceHandle &&
        (e.targetHandle || null) === targetHandle
    );
  }

  const id = edge.id || `cedge-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const record = {
    id,
    scopeKey,
    source: edge.source,
    target: edge.target,
    sourceHandle,
    targetHandle,
    label: edge.label?.trim() || 'flow',
  };
  storeState.customEdges = [...storeState.customEdges, record];
  saveStoreToDisk();
  return record;
}

export function deleteCustomEdge(id) {
  const before = storeState.customEdges.length;
  storeState.customEdges = storeState.customEdges.filter((e) => e.id !== id);
  saveStoreToDisk();
  return { success: true, id, deleted: storeState.customEdges.length < before };
}

export function listCustomEdges(scopeKey) {
  if (!scopeKey) return [...storeState.customEdges];
  return storeState.customEdges.filter((e) => e.scopeKey === scopeKey);
}

// ---------------- NODE POSITIONS ----------------

export function setNodePosition(scopeKey, nodeId, pos) {
  if (!scopeKey || !nodeId || !pos) throw new Error('ScopeKey, nodeId, and {x, y} required');
  const scopePositions = { ...(storeState.savedPositions[scopeKey] || {}) };
  scopePositions[nodeId] = { x: Math.round(pos.x), y: Math.round(pos.y) };
  storeState.savedPositions = {
    ...storeState.savedPositions,
    [scopeKey]: scopePositions,
  };
  saveStoreToDisk();
  return { success: true, scopeKey, nodeId, position: scopePositions[nodeId] };
}

export function resetNodePosition(scopeKey, nodeId) {
  if (!scopeKey || !nodeId) throw new Error('ScopeKey and nodeId required');
  if (storeState.savedPositions[scopeKey]) {
    const scopePositions = { ...storeState.savedPositions[scopeKey] };
    delete scopePositions[nodeId];
    storeState.savedPositions = {
      ...storeState.savedPositions,
      [scopeKey]: scopePositions,
    };
    saveStoreToDisk();
  }
  return { success: true, scopeKey, nodeId };
}

// ---------------- NODE COLORS & DEADLINES ----------------

export function setNodeColor(color, nodeId, nodeType) {
  if (!color || typeof color !== 'string') throw new Error('Valid color hex required');
  if (nodeId) {
    storeState.nodeColors.byNodeId = {
      ...storeState.nodeColors.byNodeId,
      [nodeId]: color,
    };
  } else if (nodeType) {
    storeState.nodeColors.byType = {
      ...storeState.nodeColors.byType,
      [nodeType]: color,
    };
  } else {
    throw new Error('Either nodeId or nodeType must be specified');
  }
  saveStoreToDisk();
  return { ...storeState.nodeColors };
}

export function setNodeDeadline(nodeId, deadlineAt, startAt) {
  if (!nodeId || !deadlineAt) throw new Error('nodeId and deadlineAt required');
  const record = {
    startAt: startAt || new Date().toISOString(),
    deadlineAt: new Date(deadlineAt).toISOString(),
  };
  storeState.deadlineOverrides = {
    ...storeState.deadlineOverrides,
    [nodeId]: record,
  };
  saveStoreToDisk();
  return { success: true, nodeId, ...record };
}

export function resetVisualState(target = 'all', scopeKey) {
  if (target === 'all') {
    storeState = defaultState();
  } else if (target === 'annotations') {
    if (scopeKey) {
      storeState.stickyNotes = storeState.stickyNotes.filter((n) => n.scopeKey !== scopeKey);
      storeState.groupBoxes = storeState.groupBoxes.filter((b) => b.scopeKey !== scopeKey);
    } else {
      storeState.stickyNotes = [];
      storeState.groupBoxes = [];
    }
  } else if (target === 'branching_nodes') {
    const idsToRemove = new Set(
      (scopeKey
        ? storeState.branchingNodes.filter((n) => n.scopeKey === scopeKey)
        : storeState.branchingNodes
      ).map((n) => n.id)
    );
    storeState.branchingNodes = scopeKey
      ? storeState.branchingNodes.filter((n) => n.scopeKey !== scopeKey)
      : [];
    storeState.customEdges = storeState.customEdges.filter(
      (e) => !idsToRemove.has(e.source) && !idsToRemove.has(e.target)
    );
  } else if (target === 'custom_edges') {
    storeState.customEdges = scopeKey
      ? storeState.customEdges.filter((e) => e.scopeKey !== scopeKey)
      : [];
  } else if (target === 'positions') {
    if (scopeKey) {
      delete storeState.savedPositions[scopeKey];
    } else {
      storeState.savedPositions = {};
    }
  } else if (target === 'colors') {
    storeState.nodeColors = {
      byType: { ...DEFAULT_NODE_BODY_COLORS },
      byNodeId: {},
    };
  }
  saveStoreToDisk();
  return { success: true, target, scopeKey: scopeKey || 'all' };
}
