import { useCallback, useRef } from 'react';
import type { Node } from '@xyflow/react';
import { findContainedNodeIdsForGroupBox, isAnnotationNode } from '../utils/forcePhysics';

interface UseGraphInteractionOptions {
  setNodes: React.Dispatch<React.SetStateAction<Node[]>>;
  onAnnotationDragStop?: (node: Node) => void;
  onPositionsCommit?: (updates: Array<{ id: string; x: number; y: number; nodeType?: string }>) => void;
}

/**
 * Lightweight zero-animation drag & group-containment interaction hook.
 * Lets React Flow handle native node dragging without any continuous RAF loops,
 * translates nodes inside a grouping box when the group box is dragged,
 * and persists final dropped coordinates cleanly.
 */
export function useGraphInteraction({
  setNodes,
  onAnnotationDragStop,
  onPositionsCommit,
}: UseGraphInteractionOptions) {
  const groupDragRef = useRef<{
    groupId: string;
    lastX: number;
    lastY: number;
    childIds: Set<string>;
  } | null>(null);

  const onNodeDragStart = useCallback(
    (_: unknown, node: Node, allNodes?: Node[]) => {
      if (node.type === 'groupBoxNode') {
        const snapshotNodes = Array.isArray(allNodes) ? allNodes : [];
        const childIds = new Set(findContainedNodeIdsForGroupBox(snapshotNodes, node));
        groupDragRef.current = {
          groupId: node.id,
          lastX: node.position.x,
          lastY: node.position.y,
          childIds,
        };
      } else {
        groupDragRef.current = null;
      }
    },
    []
  );

  const onNodeDrag = useCallback(
    (_: unknown, node: Node) => {
      if (
        node.type === 'groupBoxNode' &&
        groupDragRef.current &&
        groupDragRef.current.groupId === node.id
      ) {
        const dx = node.position.x - groupDragRef.current.lastX;
        const dy = node.position.y - groupDragRef.current.lastY;
        groupDragRef.current.lastX = node.position.x;
        groupDragRef.current.lastY = node.position.y;

        if ((dx !== 0 || dy !== 0) && groupDragRef.current.childIds.size > 0) {
          const childIds = groupDragRef.current.childIds;
          setNodes((prev) =>
            prev.map((n) =>
              childIds.has(n.id)
                ? { ...n, position: { x: n.position.x + dx, y: n.position.y + dy } }
                : n
            )
          );
        }
      }
    },
    [setNodes]
  );

  const onNodeDragStop = useCallback(
    (_: unknown, node: Node, allNodes?: Node[]) => {
      if (node.type === 'groupBoxNode' && groupDragRef.current?.groupId === node.id) {
        const childIds = groupDragRef.current.childIds;
        const snapshotNodes = Array.isArray(allNodes) ? allNodes : [];
        const movedChildren: Array<{ id: string; x: number; y: number; nodeType?: string }> = [];
        for (const cid of childIds) {
          const found = snapshotNodes.find((n) => n.id === cid);
          if (found) {
            movedChildren.push({
              id: cid,
              x: Math.round(found.position.x),
              y: Math.round(found.position.y),
              nodeType: found.type,
            });
          }
        }
        groupDragRef.current = null;
        onAnnotationDragStop?.(node);
        if (movedChildren.length > 0) {
          onPositionsCommit?.(movedChildren);
        }
        return;
      }

      if (isAnnotationNode(node)) {
        onAnnotationDragStop?.(node);
        return;
      }

      onPositionsCommit?.([
        {
          id: node.id,
          x: Math.round(node.position.x),
          y: Math.round(node.position.y),
          nodeType: node.type,
        },
      ]);
    },
    [onAnnotationDragStop, onPositionsCommit]
  );

  return {
    onNodeDragStart,
    onNodeDrag,
    onNodeDragStop,
  };
}
