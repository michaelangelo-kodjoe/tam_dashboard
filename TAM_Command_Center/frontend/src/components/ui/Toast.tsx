import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, Info, X } from 'lucide-react';
import { Button } from './Button';
import { cx } from '../../lib/cx';

export type ToastKind = 'success' | 'info' | 'error';
export interface ToastInput {
  kind?: ToastKind;
  message: string;
  detail?: string;
  /** One optional action, e.g. "View" */
  action?: { label: string; to: string };
}
interface ToastItem extends ToastInput { id: number; kind: ToastKind }

interface Ctx { push: (t: ToastInput) => void }
const ToastCtx = createContext<Ctx>({ push: () => {} });
export const useToast = () => useContext(ToastCtx);

const MAX = 3;
const TTL = 4000;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);
  const dismiss = useCallback((id: number) => setItems((l) => l.filter((t) => t.id !== id)), []);
  const push = useCallback((t: ToastInput) => {
    const id = ++seq.current;
    setItems((l) => [...l, { ...t, id, kind: t.kind ?? 'success' }].slice(-MAX));
  }, []);
  const ctx = useMemo(() => ({ push }), [push]);
  const errors = items.filter((t) => t.kind === 'error');
  const others = items.filter((t) => t.kind !== 'error');

  return (
    <ToastCtx.Provider value={ctx}>
      {children}
      <div className="toasts" data-testid="toast-region">
        <div aria-live="polite" role="status" className="toasts__group">
          {others.map((t) => <ToastView key={t.id} t={t} onDismiss={dismiss} />)}
        </div>
        <div aria-live="assertive" role="alert" className="toasts__group">
          {errors.map((t) => <ToastView key={t.id} t={t} onDismiss={dismiss} />)}
        </div>
      </div>
    </ToastCtx.Provider>
  );
}

function ToastView({ t, onDismiss }: { t: ToastItem; onDismiss: (id: number) => void }) {
  useEffect(() => {
    if (t.kind === 'error') return; // errors stay until dismissed
    const h = setTimeout(() => onDismiss(t.id), TTL);
    return () => clearTimeout(h);
  }, [t.id, t.kind, onDismiss]);
  const Icon = t.kind === 'success' ? CheckCircle2 : t.kind === 'error' ? AlertTriangle : Info;
  return (
    <div className={cx('toast', `toast--${t.kind}`)}>
      <Icon size={16} strokeWidth={1.5} aria-hidden="true" className="toast__icon" />
      <div className="toast__body">
        <p className="toast__msg">{t.message}</p>
        {t.detail && <p className="toast__detail">{t.detail}</p>}
      </div>
      {t.action && (
        <Link className="toast__action" to={t.action.to} onClick={() => onDismiss(t.id)}>
          {t.action.label}
        </Link>
      )}
      <Button variant="icon" size="sm" aria-label="Dismiss notification" onClick={() => onDismiss(t.id)} icon={<X size={14} strokeWidth={1.5} />} />
    </div>
  );
}
