import { useId, useState, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { Overlay } from './Overlay';
import { Button } from './Button';
import { ConfirmDialog } from './ConfirmDialog';

export interface DrawerProps {
  /** Object type shown in the header, e.g. "Task" */
  kind: string;
  title?: string;
  onClose: () => void;
  /** Unsaved changes: closing asks "Discard changes?" */
  dirty?: boolean;
  busy?: boolean;
  onSubmitShortcut?: () => void;
  footer: ReactNode;
  children: ReactNode;
}

/** Right-side editor drawer (480px). Same modal rules as Dialog plus the dirty guard (guidelines §7). */
export function Drawer({ kind, title, onClose, dirty, busy, onSubmitShortcut, footer, children }: DrawerProps) {
  const tid = useId();
  const [confirming, setConfirming] = useState(false);
  const requestClose = () => {
    if (busy) return;
    if (dirty) setConfirming(true);
    else onClose();
  };
  return (
    <>
      <Overlay variant="drawer" labelledBy={tid} onClose={requestClose} closable={!busy && !confirming} closeOnScrim={!dirty} onSubmitShortcut={confirming ? undefined : onSubmitShortcut}>
        <header className="overlay__head">
          <div className="overlay__titles">
            <span className="label">{kind}</span>
            <h2 id={tid} className="overlay__title truncate">{title || kind}</h2>
          </div>
          <Button variant="icon" size="sm" aria-label={`Close ${kind.toLowerCase()} editor`} title="Close" onClick={requestClose} icon={<X size={16} strokeWidth={1.5} />} />
        </header>
        <div className="overlay__body overlay__body--scroll">{children}</div>
        <footer className="overlay__foot overlay__foot--drawer">{footer}</footer>
      </Overlay>
      {confirming && (
        <ConfirmDialog
          title="Discard changes?"
          description="You have unsaved changes. If you discard them, they cannot be recovered."
          confirmLabel="Discard"
          cancelLabel="Keep editing"
          cancelVariant="primary"
          tone="danger"
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            setConfirming(false);
            onClose();
          }}
        />
      )}
    </>
  );
}
