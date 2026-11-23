import type { Edge, Node } from '@xyflow/react';

export interface ForceBody {
  id: string;
  parentId?: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  anchorX: number;
  anchorY: number;
  width: number;
  height: number;
  phaseX: number;
  phaseY: number;
  freqX: number;
  freqY: number;
  parentBounds?: { width: number; height: number; paddingTop: number; paddingSide: number };
}

export interface ForceLink {
  source: string;
  target: string;
}

function hashSeed(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967295;
}

export function createForceBodies(nodes: Node[]): Map<string, ForceBody> {
  const byId = new Map<string, Node>(nodes.map((n) => [n.id, n]));
  const bodies = new Map<string, ForceBody>();

  for (const node of nodes) {
    const seed = hashSeed(node.id);
    const seed2 = hashSeed(`${node.id}-alt`);
    const width = typeof node.style?.width === 'number' ? node.style.width : 300;
    const height = typeof node.style?.height === 'number' ? node.style.height : 160;
    const parent = node.parentId ? byId.get(node.parentId) : undefined;
    const parentBounds = parent
      ? {
          width: typeof parent.style?.width === 'number' ? parent.style.width : 640,
          height: typeof parent.style?.height === 'number' ? parent.style.height : 400,
          paddingTop: 86,
          paddingSide: 16,
        }
      : undefined;

    bodies.set(node.id, {
      id: node.id,
      parentId: node.parentId,
      x: node.position.x,
      y: node.position.y,
      vx: 0,
      vy: 0,
      anchorX: node.position.x,
      anchorY: node.position.y,
      width,
      height,
      phaseX: seed * Math.PI * 2,
      phaseY: seed2 * Math.PI * 2,
      freqX: 0.55 + seed * 0.35,
      freqY: 0.48 + seed2 * 0.32,
      parentBounds,
    });
  }

  return bodies;
}

export interface UserAnchor {
  x: number;
  y: number;
  width: number;
  height: number;
  parentId?: string;
}

export function setForceBodyAnchor(
  bodies: Map<string, ForceBody>,
  id: string,
  x: number,
  y: number
): { x: number; y: number } | null {
  const body = bodies.get(id);
  if (!body) return null;

  let nextX = x;
  let nextY = y;
  if (body.parentBounds) {
    const minX = body.parentBounds.paddingSide;
    const minY = body.parentBounds.paddingTop;
    const maxX = Math.max(minX, body.parentBounds.width - body.width - body.parentBounds.paddingSide);
    const maxY = Math.max(minY, body.parentBounds.height - body.height - body.parentBounds.paddingSide);
    nextX = Math.min(maxX, Math.max(minX, nextX));
    nextY = Math.min(maxY, Math.max(minY, nextY));
  }

  body.x = nextX;
  body.y = nextY;
  body.anchorX = nextX;
  body.anchorY = nextY;
  body.vx = 0;
  body.vy = 0;
  return { x: nextX, y: nextY };
}

export function applyUserAnchorsToNodes(
  nodes: Node[],
  userAnchors: Map<string, UserAnchor>
): Node[] {
  if (userAnchors.size === 0) return nodes;
  return nodes.map((node) => {
    const anchor = userAnchors.get(node.id);
    if (!anchor) return node;
    const width = typeof node.style?.width === 'number' ? node.style.width : 300;
    const height = typeof node.style?.height === 'number' ? node.style.height : 160;
    if (anchor.parentId !== node.parentId || anchor.width !== width || anchor.height !== height) {
      return node;
    }
    return {
      ...node,
      position: { x: anchor.x, y: anchor.y },
    };
  });
}

export function syncForceAnchors(
  prevBodies: Map<string, ForceBody>,
  nodes: Node[],
  preservePositions: boolean
): Map<string, ForceBody> {
  const fresh = createForceBodies(nodes);
  for (const [id, nextBody] of fresh.entries()) {
    const old = prevBodies.get(id);
    if (old) {
      nextBody.vx = old.vx;
      nextBody.vy = old.vy;
      if (preservePositions && !nextBody.parentId) {
        nextBody.x = old.x;
        nextBody.y = old.y;
      }
    }
  }
  return fresh;
}

export interface StepForceOptions {
  timeSec: number;
  dtSec?: number;
  draggedId?: string | null;
  hoveredId?: string | null;
  links?: ForceLink[];
  amplitude?: number;
}

/**
 * Pure React-Force-Graph style spring-buoyancy + edge coupling + soft collision step.
 * Keeps nodes gently floating around their anchor layout while responding organically
 * to drag/link forces and settling smoothly when released.
 */
export function stepForceSimulation(
  bodies: Map<string, ForceBody>,
  options: StepForceOptions
): Map<string, { x: number; y: number }> {
  const {
    timeSec,
    dtSec = 0.032,
    draggedId = null,
    hoveredId = null,
    links = [],
    amplitude = 4.5,
  } = options;

  const dt = Math.min(0.05, Math.max(0.008, dtSec));
  const bodyList = Array.from(bodies.values());

  // 1. Anchor spring + harmonic floaty buoyancy
  for (const body of bodyList) {
    if (body.id === draggedId) {
      body.vx = 0;
      body.vy = 0;
      continue;
    }

    const isChild = Boolean(body.parentId);
    const amp = body.id === hoveredId ? 0 : isChild ? amplitude * 0.48 : amplitude;
    const floatOffsetX = Math.sin(timeSec * body.freqX + body.phaseX) * amp;
    const floatOffsetY = Math.cos(timeSec * body.freqY + body.phaseY) * amp * 0.85;

    const targetX = body.anchorX + floatOffsetX;
    const targetY = body.anchorY + floatOffsetY;

    const stiffness = body.id === hoveredId ? 14 : 6.5;
    body.vx += (targetX - body.x) * stiffness * dt;
    body.vy += (targetY - body.y) * stiffness * dt;
  }

  // 2. Soft spring pull along active edges when a connected node is displaced (e.g. dragged)
  for (const link of links) {
    const a = bodies.get(link.source);
    const b = bodies.get(link.target);
    if (!a || !b || a.parentId !== b.parentId) continue;

    const restDx = b.anchorX - a.anchorX;
    const restDy = b.anchorY - a.anchorY;
    const curDx = b.x - a.x;
    const curDy = b.y - a.y;

    const stretchX = curDx - restDx;
    const stretchY = curDy - restDy;

    const linkK = 1.6;
    if (a.id !== draggedId && a.id !== hoveredId) {
      a.vx += stretchX * linkK * dt;
      a.vy += stretchY * linkK * dt;
    }
    if (b.id !== draggedId && b.id !== hoveredId) {
      b.vx -= stretchX * linkK * dt;
      b.vy -= stretchY * linkK * dt;
    }
  }

  // 3. Soft sibling repulsion only when nodes physically overlap
  for (let i = 0; i < bodyList.length; i++) {
    for (let j = i + 1; j < bodyList.length; j++) {
      const a = bodyList[i];
      const b = bodyList[j];
      if (a.parentId !== b.parentId) continue;

      const ax = a.x + a.width * 0.5;
      const ay = a.y + a.height * 0.5;
      const bx = b.x + b.width * 0.5;
      const by = b.y + b.height * 0.5;

      const minSepX = (a.width + b.width) * 0.5;
      const minSepY = (a.height + b.height) * 0.5;
      const dx = bx - ax;
      const dy = by - ay;

      if (Math.abs(dx) < minSepX && Math.abs(dy) < minSepY) {
        const overlapX = minSepX - Math.abs(dx);
        const overlapY = minSepY - Math.abs(dy);
        const pushK = 2.4;
        if (overlapX < overlapY) {
          const dir = dx >= 0 ? 1 : -1;
          if (a.id !== draggedId && a.id !== hoveredId) a.vx -= dir * overlapX * pushK * dt;
          if (b.id !== draggedId && b.id !== hoveredId) b.vx += dir * overlapX * pushK * dt;
        } else {
          const dir = dy >= 0 ? 1 : -1;
          if (a.id !== draggedId && a.id !== hoveredId) a.vy -= dir * overlapY * pushK * dt;
          if (b.id !== draggedId && b.id !== hoveredId) b.vy += dir * overlapY * pushK * dt;
        }
      }
    }
  }

  // 4. Velocity damping + position update (clamped inside parent container if nested)
  const positions = new Map<string, { x: number; y: number }>();
  const damping = 0.84;

  for (const body of bodyList) {
    if (body.id !== draggedId) {
      body.vx *= damping;
      body.vy *= damping;
      body.x += body.vx * dt * 24;
      body.y += body.vy * dt * 24;

      if (body.parentBounds) {
        const minX = body.parentBounds.paddingSide;
        const minY = body.parentBounds.paddingTop;
        const maxX = Math.max(minX, body.parentBounds.width - body.width - body.parentBounds.paddingSide);
        const maxY = Math.max(minY, body.parentBounds.height - body.height - body.parentBounds.paddingSide);
        body.x = Math.min(maxX, Math.max(minX, body.x));
        body.y = Math.min(maxY, Math.max(minY, body.y));
      }
    }
    positions.set(body.id, { x: body.x, y: body.y });
  }

  return positions;
}

export function extractForceLinks(edges: Edge[]): ForceLink[] {
  return edges.map((e) => ({ source: e.source, target: e.target }));
}
