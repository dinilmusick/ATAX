import React, { useEffect, useRef } from 'react';
import {
  BoxSelect,
  GitBranch,
  GitMerge,
  Info,
  PlusSquare,
  RotateCcw,
  Split,
  StickyNote,
  Trash2,
} from 'lucide-react';
import type { BranchingNodeKind } from '../types/substrate';

export type ContextMenuState =
  | {
      kind: 'pane';
      clientX: number;
      clientY: number;
      flowX: number;
      flowY: number;
    }
  | {
      kind: 'node';
      clientX: number;
      clientY: number;
      nodeId: string;
      nodeType: string;
      nodeLabel: string;
      isDeletable: boolean;
      flowX?: number;
      flowY?: number;
    }
  | {
      kind: 'edge';
      clientX: number;
      clientY: number;
      edgeId: string;
      edgeLabel?: string;
      isCustomEdge: boolean;
    }
  | null;

interface GraphContextMenuProps {
  menu: ContextMenuState;
  domainAddLabel: string;
  onClose: () => void;
  onAddDomainNode: (flowX: number, flowY: number) => void;
  onAddBranchingNode: (kind: BranchingNodeKind, flowX: number, flowY: number) => void;
  onAddStickyNote: (flowX: number, flowY: number) => void;
  onAddGroupingBox: (flowX: number, flowY: number) => void;
  onInspectNode?: (nodeId: string) => void;
  onDeleteNode?: (nodeId: string) => void;
  onResetNodePosition?: (nodeId: string) => void;
  onDeleteEdge?: (edgeId: string) => void;
}

export function GraphContextMenu({
  menu,
  domainAddLabel,
  onClose,
  onAddDomainNode,
  onAddBranchingNode,
  onAddStickyNote,
  onAddGroupingBox,
  onInspectNode,
  onDeleteNode,
  onResetNodePosition,
  onDeleteEdge,
}: GraphContextMenuProps) {
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!menu) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    const handlePointer = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKey);
    window.addEventListener('mousedown', handlePointer);
    return () => {
      window.removeEventListener('keydown', handleKey);
      window.removeEventListener('mousedown', handlePointer);
    };
  }, [menu, onClose]);

  if (!menu) return null;

  const menuWidth = 256;
  const estimatedHeight = menu.kind === 'pane' ? 320 : 140;
  const left =
    typeof window !== 'undefined'
      ? Math.min(menu.clientX, Math.max(8, window.innerWidth - menuWidth - 12))
      : menu.clientX;
  const top =
    typeof window !== 'undefined'
      ? Math.min(menu.clientY, Math.max(8, window.innerHeight - estimatedHeight - 12))
      : menu.clientY;

  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label="Graph canvas actions"
      data-testid="graph-context-menu"
      onContextMenu={(e) => e.preventDefault()}
      className="fixed z-50 w-64 bg-[#1B120F] border border-[#594238] shadow-2xl rounded-sm py-1.5 text-[#F7F3EC] font-mono text-xs"
      style={{ left, top }}
    >
      {menu.kind === 'pane' && (
        <>
          <div className="px-3 py-1 text-[10px] uppercase tracking-wider text-[#B9AA9D]">
            Add Node
          </div>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              onAddDomainNode(menu.flowX, menu.flowY);
              onClose();
            }}
            className="w-full px-3 py-2 flex items-center gap-2.5 text-left hover:bg-[#2C1E19] text-[#F7F3EC] transition-colors cursor-pointer"
          >
            <PlusSquare className="w-3.5 h-3.5 text-[#DF6B3B] shrink-0" />
            <span>{domainAddLabel}</span>
          </button>

          <div className="my-1 border-t border-[#382821]" />
          <div className="px-3 py-1 text-[10px] uppercase tracking-wider text-[#B9AA9D]">
            Branching Logic
          </div>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              onAddBranchingNode('multi_in_single_out', menu.flowX, menu.flowY);
              onClose();
            }}
            className="w-full px-3 py-2 flex items-center gap-2.5 text-left hover:bg-[#2C1E19] text-[#F7F3EC] transition-colors cursor-pointer"
          >
            <GitMerge className="w-3.5 h-3.5 text-[#06B6D4] shrink-0" />
            <span>Multi-In → Single-Out Selector</span>
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              onAddBranchingNode('single_in_multi_out', menu.flowX, menu.flowY);
              onClose();
            }}
            className="w-full px-3 py-2 flex items-center gap-2.5 text-left hover:bg-[#2C1E19] text-[#F7F3EC] transition-colors cursor-pointer"
          >
            <GitBranch className="w-3.5 h-3.5 text-[#F43F5E] shrink-0" />
            <span>Single-In → Multi-Out Selector</span>
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              onAddBranchingNode('fan_out', menu.flowX, menu.flowY);
              onClose();
            }}
            className="w-full px-3 py-2 flex items-center gap-2.5 text-left hover:bg-[#2C1E19] text-[#F7F3EC] transition-colors cursor-pointer"
          >
            <Split className="w-3.5 h-3.5 text-[#84CC16] shrink-0" />
            <span>Fan-Out Node</span>
          </button>

          <div className="my-1 border-t border-[#382821]" />
          <div className="px-3 py-1 text-[10px] uppercase tracking-wider text-[#B9AA9D]">
            Canvas Annotations
          </div>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              onAddStickyNote(menu.flowX, menu.flowY);
              onClose();
            }}
            className="w-full px-3 py-2 flex items-center gap-2.5 text-left hover:bg-[#2C1E19] text-[#F7F3EC] transition-colors cursor-pointer"
          >
            <StickyNote className="w-3.5 h-3.5 text-[#FDE047] shrink-0" />
            <span>Add Sticky Note</span>
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              onAddGroupingBox(menu.flowX, menu.flowY);
              onClose();
            }}
            className="w-full px-3 py-2 flex items-center gap-2.5 text-left hover:bg-[#2C1E19] text-[#F7F3EC] transition-colors cursor-pointer"
          >
            <BoxSelect className="w-3.5 h-3.5 text-[#E04819] shrink-0" />
            <span>Add Grouping Box</span>
          </button>
        </>
      )}

      {menu.kind === 'node' && (
        <>
          <div className="px-3 py-1 text-[10px] uppercase tracking-wider text-[#B9AA9D] truncate">
            {menu.nodeLabel}
          </div>
          {menu.nodeType === 'groupBoxNode' &&
            typeof menu.flowX === 'number' &&
            typeof menu.flowY === 'number' && (
              <>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    onAddDomainNode(menu.flowX!, menu.flowY!);
                    onClose();
                  }}
                  className="w-full px-3 py-1.5 flex items-center gap-2.5 text-left hover:bg-[#2C1E19] text-[#F7F3EC] transition-colors cursor-pointer"
                >
                  <PlusSquare className="w-3.5 h-3.5 text-[#DF6B3B] shrink-0" />
                  <span>{domainAddLabel}</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    onAddBranchingNode('multi_in_single_out', menu.flowX!, menu.flowY!);
                    onClose();
                  }}
                  className="w-full px-3 py-1.5 flex items-center gap-2.5 text-left hover:bg-[#2C1E19] text-[#F7F3EC] transition-colors cursor-pointer"
                >
                  <GitMerge className="w-3.5 h-3.5 text-[#06B6D4] shrink-0" />
                  <span>Multi-In → Single-Out Selector</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    onAddBranchingNode('single_in_multi_out', menu.flowX!, menu.flowY!);
                    onClose();
                  }}
                  className="w-full px-3 py-1.5 flex items-center gap-2.5 text-left hover:bg-[#2C1E19] text-[#F7F3EC] transition-colors cursor-pointer"
                >
                  <GitBranch className="w-3.5 h-3.5 text-[#F43F5E] shrink-0" />
                  <span>Single-In → Multi-Out Selector</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    onAddBranchingNode('fan_out', menu.flowX!, menu.flowY!);
                    onClose();
                  }}
                  className="w-full px-3 py-1.5 flex items-center gap-2.5 text-left hover:bg-[#2C1E19] text-[#F7F3EC] transition-colors cursor-pointer"
                >
                  <Split className="w-3.5 h-3.5 text-[#84CC16] shrink-0" />
                  <span>Fan-Out Node</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    onAddStickyNote(menu.flowX!, menu.flowY!);
                    onClose();
                  }}
                  className="w-full px-3 py-1.5 flex items-center gap-2.5 text-left hover:bg-[#2C1E19] text-[#F7F3EC] transition-colors cursor-pointer"
                >
                  <StickyNote className="w-3.5 h-3.5 text-[#FDE047] shrink-0" />
                  <span>Add Sticky Note</span>
                </button>
                <div className="my-1 border-t border-[#382821]" />
              </>
            )}
          {menu.nodeType !== 'groupBoxNode' &&
            menu.nodeType !== 'stickyNoteNode' &&
            onInspectNode && (
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  onInspectNode(menu.nodeId);
                  onClose();
                }}
                className="w-full px-3 py-2 flex items-center gap-2.5 text-left hover:bg-[#2C1E19] text-[#F7F3EC] transition-colors cursor-pointer"
              >
                <Info className="w-3.5 h-3.5 text-[#DF6B3B] shrink-0" />
                <span>Inspect / Edit Node</span>
              </button>
            )}
          {onResetNodePosition && menu.nodeType !== 'groupBoxNode' && menu.nodeType !== 'stickyNoteNode' && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                onResetNodePosition(menu.nodeId);
                onClose();
              }}
              className="w-full px-3 py-2 flex items-center gap-2.5 text-left hover:bg-[#2C1E19] text-[#F7F3EC] transition-colors cursor-pointer"
            >
              <RotateCcw className="w-3.5 h-3.5 text-[#B9AA9D] shrink-0" />
              <span>Reset Node Position</span>
            </button>
          )}
          {menu.isDeletable && onDeleteNode && (
            <>
              <div className="my-1 border-t border-[#382821]" />
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  onDeleteNode(menu.nodeId);
                  onClose();
                }}
                className="w-full px-3 py-2 flex items-center gap-2.5 text-left hover:bg-[#3A1713] text-[#FCA5A5] transition-colors cursor-pointer"
              >
                <Trash2 className="w-3.5 h-3.5 shrink-0" />
                <span>Delete Node</span>
              </button>
            </>
          )}
        </>
      )}

      {menu.kind === 'edge' && (
        <>
          <div className="px-3 py-1 text-[10px] uppercase tracking-wider text-[#B9AA9D] truncate">
            Connection{menu.edgeLabel ? ` · ${menu.edgeLabel}` : ''}
          </div>
          {menu.isCustomEdge && onDeleteEdge ? (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                onDeleteEdge(menu.edgeId);
                onClose();
              }}
              className="w-full px-3 py-2 flex items-center gap-2.5 text-left hover:bg-[#3A1713] text-[#FCA5A5] transition-colors cursor-pointer"
            >
              <Trash2 className="w-3.5 h-3.5 shrink-0" />
              <span>Delete Connection</span>
            </button>
          ) : (
            <div className="px-3 py-2 text-[11px] text-[#B9AA9D]">
              Substrate ledger edge (read-only)
            </div>
          )}
        </>
      )}
    </div>
  );
}
