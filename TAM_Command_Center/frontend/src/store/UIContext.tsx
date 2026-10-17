import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import type { NoteType } from '../types';
import { parseActionItems, prefillFor, type TaskPrefill } from '../lib/actionItems';

export type CaptureType = 'task' | 'follow_up' | 'Meeting Note' | 'Call Note' | 'General Note';
export interface CapturePrefill {
  type?: CaptureType;
  clientId?: string | null;
}

export interface ActionQueue { clientId: string; noteLabel: string; items: string[]; index: number; phase: 'ask' | 'drawer' }

interface UICtx {
  /** Action items of a just-saved note, asked one by one ("Create a task from this action item?"). */
  actionQueue: ActionQueue | null;
  offerActionItems: (input: { clientId: string; noteLabel: string; actionItems: string | null }) => void;
  answerActionItem: (yes: boolean) => void;
  /** Called when the prefilled new-task drawer closes (saved or not): moves to the next item. */
  finishActionItem: () => void;
  taskPrefill: TaskPrefill | null;
  capture: { open: boolean; prefill: CapturePrefill };
  openCapture: (p?: CapturePrefill) => void;
  closeCapture: () => void;
  /** Top-bar account jump input; Ctrl+K focuses it */
  jumpRef: RefObject<HTMLInputElement>;
  focusJump: () => void;
}
const Ctx = createContext<UICtx | null>(null);

export function UIProvider({ children }: { children: ReactNode }) {
  const [capture, setCapture] = useState<UICtx['capture']>({ open: false, prefill: {} });
  const jumpRef = useRef<HTMLInputElement>(null);
  const [actionQueue, setActionQueue] = useState<ActionQueue | null>(null);
  const offerActionItems = useCallback(({ clientId, noteLabel, actionItems }: { clientId: string; noteLabel: string; actionItems: string | null }) => {
    const items = parseActionItems(actionItems);
    if (items.length) setActionQueue({ clientId, noteLabel, items, index: 0, phase: 'ask' });
  }, []);
  const advance = useCallback(() => setActionQueue((q) => (q && q.index + 1 < q.items.length ? { ...q, index: q.index + 1, phase: 'ask' } : null)), []);
  const answerActionItem = useCallback((yes: boolean) => { if (yes) setActionQueue((q) => (q ? { ...q, phase: 'drawer' } : q)); else advance(); }, [advance]);
  const finishActionItem = advance;
  const taskPrefill = useMemo(() => (actionQueue && actionQueue.phase === 'drawer' ? prefillFor(actionQueue.items[actionQueue.index], actionQueue.noteLabel, actionQueue.clientId, { index: actionQueue.index, total: actionQueue.items.length }) : null), [actionQueue]);
  const openCapture = useCallback((p: CapturePrefill = {}) => setCapture({ open: true, prefill: p }), []);
  const closeCapture = useCallback(() => setCapture((c) => ({ ...c, open: false })), []);
  const focusJump = useCallback(() => jumpRef.current?.focus(), []);
  const value = useMemo(() => ({ capture, openCapture, closeCapture, jumpRef, focusJump, actionQueue, offerActionItems, answerActionItem, finishActionItem, taskPrefill }), [capture, openCapture, closeCapture, focusJump, actionQueue, offerActionItems, answerActionItem, finishActionItem, taskPrefill]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useUI(): UICtx {
  const v = useContext(Ctx);
  if (!v) throw new Error('useUI must be used inside <UIProvider>');
  return v;
}

export function isNoteType(t: CaptureType): t is NoteType {
  return t === 'Meeting Note' || t === 'Call Note' || t === 'General Note';
}
