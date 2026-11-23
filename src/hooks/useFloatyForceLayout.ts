import { useCallback, useEffect, useRef } from 'react';
import type { Edge, Node } from '@xyflow/react';
import {
  applyUserAnchorsToNodes,
  createForceBodies,
  extractForceLinks,
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
}

/**
 * Animates React Flow nodes with a continuous React-Force-Graph style
 * harmonic buoyancy + spring-coupled drag response, while anchoring
 * each node at the exact position where the user drops it.
 */
export function useFloatyForceLayout({
  baseNodes,
  edges,
  setNodes,
  enabled = true,
  amplitude = 4.5,
}: UseFloatyForceLayoutOptions) {
  const bodiesRef = useRef<Map<string, ForceBody>>(new Map());
  const userAnchorsRef = useRef<Map<string, UserAnchor>>(new Map());
  const draggedIdRef = useRef<string | null>(null);
  const hoveredIdRef = useRef<string | null>(null);
  const edgesRef = useRef<Edge[]>(edges);
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
  }, []);

  useEffect(() => {
    if (!enabled) return;

    let rafId = 0;
    let lastTick = performance.now();

    const loop = (now: number) => {
      const elapsed = now - lastTick;
      if (elapsed >= 32) {
        lastTick = now;
        const bodies = bodiesRef.current;
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
              if (node.id === draggedIdRef.current) return node;
              const pos = nextPositions.get(node.id);
              if (!pos) return node;
              if (
                Math.abs(pos.x - node.position.x) < 0.05 &&
                Math.abs(pos.y - node.position.y) < 0.05
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

  const onNodeDragStart = useCallback((_: unknown, node: Node) => {
    draggedIdRef.current = node.id;
    const body = bodiesRef.current.get(node.id);
    if (body) {
      body.x = node.position.x;
      body.y = node.position.y;
      body.vx = 0;
      body.vy = 0;
    }
  }, []);

  const onNodeDrag = useCallback((_: unknown, node: Node) => {
    draggedIdRef.current = node.id;
    const body = bodiesRef.current.get(node.id);
    if (body) {
      body.x = node.position.x;
      body.y = node.position.y;
      body.vx = 0;
      body.vy = 0;
    }
  }, []);

  const onNodeDragStop = useCallback(
    (_: unknown, node: Node) => {
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
    [setNodes]
  );

  const onNodeMouseEnter = useCallback((_: unknown, node: Node) => {
    hoveredIdRef.current = node.id;
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
