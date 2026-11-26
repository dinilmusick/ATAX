import { useCallback, useEffect, useRef } from 'react';
import type { Edge, Node } from '@xyflow/react';
import {
  applyUserAnchorsToNodes,
  createForceBodies,
  extractForceLinks,
  findContainedNodeIdsForGroupBox,
  isAnnotationNode,
  setForceBodyAnchor,
  stepForceSimulation,
  syncForceAnchors,
  type ForceBody,
  type UserAnchor,
} from '../utils/forcePhysics';

interface UseFloatyForceLayoutOptions {
  baseNodes: Node[];
  edges: Edge[];
  setNodes: React.Dispatch<React.SetStateAction<Node[]>>;
  enabled?: boolean;
  amplitude?: number;
  onAnnotationDragStop?: (node: Node) => void;
}

/**
 * Animates React Flow nodes with a continuous React-Force-Graph style
 * harmonic buoyancy + spring-coupled drag response, while anchoring
 * each node at the exact position where the user drops it.
 * Annotation nodes (sticky notes & grouping boxes) stay stationary and
 * dragging a grouping box translates nodes inside its bounds.
 */
export function useFloatyForceLayout({
  baseNodes,
  edges,
  setNodes,
  enabled = true,
  amplitude = 4.5,
  onAnnotationDragStop,
}: UseFloatyForceLayoutOptions) {
  const bodiesRef = useRef<Map<string, ForceBody>>(new Map());
  const userAnchorsRef = useRef<Map<string, UserAnchor>>(new Map());
  const draggedIdRef = useRef<string | null>(null);
  const hoveredIdRef = useRef<string | null>(null);
  const edgesRef = useRef<Edge[]>(edges);
  const groupDragRef = useRef<{
    groupId: string;
    lastX: number;
    lastY: number;
    childIds: Set<string>;
  } | null>(null);
  const startTimeRef = useRef<number>(typeof performance !== 'undefined' ? performance.now() : 0);

  useEffect(() => {
    edgesRef.current = edges;
  }, [edges]);

  useEffect(() => {
    const anchored = applyUserAnchorsToNodes(baseNodes, userAnchorsRef.current);
    bodiesRef.current = syncForceAnchors(bodiesRef.current, anchored, false);
  }, [baseNodes]);

  const applySavedAnchors = useCallback((freshNodes: Node[]) => {
    return applyUserAnchorsToNodes(freshNodes, userAnchorsRef.current);
  }, []);

  const resetBodies = useCallback((freshNodes: Node[], clearUserAnchors = false) => {
    if (clearUserAnchors) {
      userAnchorsRef.current.clear();
    }
    const anchored = applyUserAnchorsToNodes(freshNodes, userAnchorsRef.current);
    bodiesRef.current = createForceBodies(anchored);
    draggedIdRef.current = null;
    groupDragRef.current = null;
  }, []);

  useEffect(() => {
    if (!enabled) return;

    let rafId = 0;
    let lastTick = performance.now();

    const loop = (now: number) => {
      const elapsed = now - lastTick;
      if (elapsed >= 48) {
        lastTick = now;
        const bodies = bodiesRef.current;
        const activeGroupChildren = groupDragRef.current?.childIds;
        const shouldAnimate =
          bodies.size > 0 && (bodies.size <= 32 || draggedIdRef.current !== null);
        if (shouldAnimate) {
          const timeSec = (now - startTimeRef.current) / 1000;
          const nextPositions = stepForceSimulation(bodies, {
            timeSec,
            dtSec: elapsed / 1000,
            draggedId: draggedIdRef.current,
            hoveredId: hoveredIdRef.current,
            links: extractForceLinks(edgesRef.current),
            amplitude,
          });

          setNodes((prev) =>
            prev.map((node) => {
              if (isAnnotationNode(node)) return node;
              if (node.id === draggedIdRef.current) return node;
              if (activeGroupChildren?.has(node.id)) return node;
              const pos = nextPositions.get(node.id);
              if (!pos) return node;
              if (
                Math.abs(pos.x - node.position.x) < 0.12 &&
                Math.abs(pos.y - node.position.y) < 0.12
              ) {
                return node;
              }
              return {
                ...node,
                position: pos,
              };
            })
          );
        }
      }
      rafId = requestAnimationFrame(loop);
    };

    rafId = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafId);
  }, [enabled, amplitude, setNodes]);

  const onNodeDragStart = useCallback(
    (_: unknown, node: Node, allNodes?: Node[]) => {
      draggedIdRef.current = node.id;
      if (node.type === 'groupBoxNode') {
        const snapshotNodes = Array.isArray(allNodes) && allNodes.length > 0 ? allNodes : baseNodes;
        const childIds = new Set(findContainedNodeIdsForGroupBox(snapshotNodes, node));
        groupDragRef.current = {
          groupId: node.id,
          lastX: node.position.x,
          lastY: node.position.y,
          childIds,
        };
        return;
      }

      const body = bodiesRef.current.get(node.id);
      if (body) {
        body.x = node.position.x;
        body.y = node.position.y;
        body.vx = 0;
        body.vy = 0;
      }
    },
    [baseNodes]
  );

  const onNodeDrag = useCallback(
    (_: unknown, node: Node) => {
      draggedIdRef.current = node.id;
      if (
        node.type === 'groupBoxNode' &&
        groupDragRef.current &&
        groupDragRef.current.groupId === node.id
      ) {
        const dx = node.position.x - groupDragRef.current.lastX;
        const dy = node.position.y - groupDragRef.current.lastY;
        groupDragRef.current.lastX = node.position.x;
        groupDragRef.current.lastY = node.position.y;

        if (dx !== 0 || dy !== 0) {
          const childIds = groupDragRef.current.childIds;
          for (const cid of childIds) {
            const body = bodiesRef.current.get(cid);
            if (body) {
              body.x += dx;
              body.y += dy;
              body.anchorX += dx;
              body.anchorY += dy;
              body.vx = 0;
              body.vy = 0;
            }
          }
          setNodes((prev) =>
            prev.map((n) =>
              childIds.has(n.id)
                ? { ...n, position: { x: n.position.x + dx, y: n.position.y + dy } }
                : n
            )
          );
        }
        return;
      }

      const body = bodiesRef.current.get(node.id);
      if (body) {
        body.x = node.position.x;
        body.y = node.position.y;
        body.vx = 0;
        body.vy = 0;
      }
    },
    [setNodes]
  );

  const onNodeDragStop = useCallback(
    (_: unknown, node: Node, allNodes?: Node[]) => {
      if (isAnnotationNode(node)) {
        if (
          node.type === 'groupBoxNode' &&
          groupDragRef.current &&
          groupDragRef.current.groupId === node.id
        ) {
          const childIds = groupDragRef.current.childIds;
          const snapshotNodes = Array.isArray(allNodes) ? allNodes : [];
          for (const cid of childIds) {
            const childNode = snapshotNodes.find((n) => n.id === cid);
            const body = bodiesRef.current.get(cid);
            const fx = childNode?.position.x ?? body?.x;
            const fy = childNode?.position.y ?? body?.y;
            if (typeof fx === 'number' && typeof fy === 'number') {
              const placedChild = setForceBodyAnchor(bodiesRef.current, cid, fx, fy);
              if (placedChild && body) {
                userAnchorsRef.current.set(cid, {
                  x: placedChild.x,
                  y: placedChild.y,
                  width: body.width,
                  height: body.height,
                  parentId: body.parentId,
                });
              }
            }
          }
          groupDragRef.current = null;
        }
        onAnnotationDragStop?.(node);
        draggedIdRef.current = null;
        return;
      }

      const placed = setForceBodyAnchor(
        bodiesRef.current,
        node.id,
        node.position.x,
        node.position.y
      );
      const finalPos = placed ?? { x: node.position.x, y: node.position.y };
      const body = bodiesRef.current.get(node.id);
      const width = body?.width ?? (typeof node.style?.width === 'number' ? node.style.width : 300);
      const height =
        body?.height ?? (typeof node.style?.height === 'number' ? node.style.height : 160);

      userAnchorsRef.current.set(node.id, {
        x: finalPos.x,
        y: finalPos.y,
        width,
        height,
        parentId: node.parentId,
      });

      setNodes((prev) =>
        prev.map((n) => (n.id === node.id ? { ...n, position: finalPos } : n))
      );
      draggedIdRef.current = null;
    },
    [setNodes, onAnnotationDragStop]
  );

  const onNodeMouseEnter = useCallback((_: unknown, node: Node) => {
    if (!isAnnotationNode(node)) {
      hoveredIdRef.current = node.id;
    }
  }, []);

  const onNodeMouseLeave = useCallback((_: unknown, node: Node) => {
    if (hoveredIdRef.current === node.id) {
      hoveredIdRef.current = null;
    }
  }, []);

  return {
    onNodeDragStart,
    onNodeDrag,
    onNodeDragStop,
    onNodeMouseEnter,
    onNodeMouseLeave,
    applySavedAnchors,
    resetBodies,
  };
}
