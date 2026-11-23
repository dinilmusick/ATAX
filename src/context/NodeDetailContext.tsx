import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';

export interface NodeDetailContextValue {
  isExpanded: (id: string) => boolean;
  isPinned: (id: string) => boolean;
  toggleExpand: (id: string) => void;
  togglePin: (id: string) => void;
  setPinned: (id: string, pinned: boolean) => void;
  collapseAllUnpinned: () => void;
  resetAll: () => void;
}

const NodeDetailContext = createContext<NodeDetailContextValue | null>(null);

export function useNodeDetail(): NodeDetailContextValue;
export function useNodeDetail(nodeId: string): {
  isExpanded: boolean;
  isPinned: boolean;
  toggleExpand: () => void;
  togglePin: () => void;
  setPinned: (pinned: boolean) => void;
  collapseAllUnpinned: () => void;
  resetAll: () => void;
};
export function useNodeDetail(nodeId?: string) {
  const ctx = useContext(NodeDetailContext);
  if (!ctx) {
    throw new Error('useNodeDetail must be used within a NodeDetailProvider');
  }
  if (!nodeId) return ctx;

  return {
    isExpanded: ctx.isExpanded(nodeId),
    isPinned: ctx.isPinned(nodeId),
    toggleExpand: () => ctx.toggleExpand(nodeId),
    togglePin: () => ctx.togglePin(nodeId),
    setPinned: (pinned: boolean) => ctx.setPinned(nodeId, pinned),
    collapseAllUnpinned: ctx.collapseAllUnpinned,
    resetAll: ctx.resetAll,
  };
}

export function NodeDetailProvider({ children }: { children: React.ReactNode }) {
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [pinnedIds, setPinnedIds] = useState<Set<string>>(new Set());

  const isExpanded = useCallback((id: string) => expandedIds.has(id), [expandedIds]);
  const isPinned = useCallback((id: string) => pinnedIds.has(id), [pinnedIds]);

  const toggleExpand = useCallback((id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
        // Also remove from pinned so next expansion starts fresh
        setPinnedIds((pPrev) => {
          if (!pPrev.has(id)) return pPrev;
          const pNext = new Set(pPrev);
          pNext.delete(id);
          return pNext;
        });
      } else {
        // Auto-collapse any existing unpinned nodes when opening a new one
        for (const openId of prev) {
          if (!pinnedIds.has(openId)) {
            next.delete(openId);
          }
        }
        next.add(id);
      }
      return next;
    });
  }, [pinnedIds]);

  const togglePin = useCallback((id: string) => {
    setPinnedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
        // Pinned node must be expanded
        setExpandedIds((ePrev) => new Set(ePrev).add(id));
      }
      return next;
    });
  }, []);

  const setPinned = useCallback((id: string, pinned: boolean) => {
    setPinnedIds((prev) => {
      const next = new Set(prev);
      if (pinned) {
        next.add(id);
        setExpandedIds((ePrev) => new Set(ePrev).add(id));
      } else {
        next.delete(id);
      }
      return next;
    });
  }, []);

  const collapseAllUnpinned = useCallback(() => {
    setExpandedIds((prev) => {
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        if (pinnedIds.has(id)) {
          next.add(id);
        } else {
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [pinnedIds]);

  const resetAll = useCallback(() => {
    setExpandedIds(new Set());
    setPinnedIds(new Set());
  }, []);

  // Click outside listener:
  // When the user clicks anywhere outside an unpinned expanded node,
  // that node automatically reverts back to minimised default state.
  // Pinned nodes will NOT minimise.
  useEffect(() => {
    const handlePointerDown = (event: MouseEvent | TouchEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target) return;

      // Collect all node IDs from the clicked target up its DOM ancestor tree
      const clickedNodeIds = new Set<string>();
      let curr: HTMLElement | null = target;
      while (curr) {
        const id = curr.getAttribute('data-node-id');
        if (id) clickedNodeIds.add(id);
        curr = curr.parentElement;
      }

      setExpandedIds((prev) => {
        if (prev.size === 0) return prev;
        let changed = false;
        const next = new Set<string>();
        for (const id of prev) {
          // If this node is pinned, it stays expanded
          if (pinnedIds.has(id)) {
            next.add(id);
            continue;
          }
          // If the click occurred inside this node or its children/overlay, keep it expanded
          if (clickedNodeIds.has(id)) {
            next.add(id);
            continue;
          }
          // Click was somewhere else in the UI -> auto-minimise!
          changed = true;
        }
        return changed ? next : prev;
      });
    };

    window.addEventListener('pointerdown', handlePointerDown);
    return () => window.removeEventListener('pointerdown', handlePointerDown);
  }, [pinnedIds]);

  return (
    <NodeDetailContext.Provider
      value={{
        isExpanded,
        isPinned,
        toggleExpand,
        togglePin,
        setPinned,
        collapseAllUnpinned,
        resetAll,
      }}
    >
      {children}
    </NodeDetailContext.Provider>
  );
}
