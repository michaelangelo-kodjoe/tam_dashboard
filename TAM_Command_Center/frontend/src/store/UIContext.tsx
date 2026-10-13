import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import type { NoteType } from '../types';

export type CaptureType = 'task' | 'follow_up' | 'Meeting Note' | 'Call Note' | 'General Note';
export interface CapturePrefill {
  type?: CaptureType;
  clientId?: string | null;
}

interface UICtx {
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
  const openCapture = useCallback((p: CapturePrefill = {}) => setCapture({ open: true, prefill: p }), []);
  const closeCapture = useCallback(() => setCapture((c) => ({ ...c, open: false })), []);
  const focusJump = useCallback(() => jumpRef.current?.focus(), []);
  const value = useMemo(() => ({ capture, openCapture, closeCapture, jumpRef, focusJump }), [capture, openCapture, closeCapture, focusJump]);
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
