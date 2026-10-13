import { useId, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { Overlay } from './Overlay';
import { Button } from './Button';

export interface DialogProps {
  title: string;
  onClose: () => void;
  closable?: boolean;
  closeOnScrim?: boolean;
  onSubmitShortcut?: () => void;
  width?: number;
  footer?: ReactNode;
  children: ReactNode;
  role?: 'dialog' | 'alertdialog';
}

export function Dialog({ title, onClose, closable = true, closeOnScrim = true, onSubmitShortcut, width = 600, footer, children, role }: DialogProps) {
  const tid = useId();
  return (
    <Overlay variant="dialog" labelledBy={tid} onClose={onClose} closable={closable} closeOnScrim={closeOnScrim} onSubmitShortcut={onSubmitShortcut} width={width} role={role}>
      <header className="overlay__head">
        <h2 id={tid} className="overlay__title">{title}</h2>
        <Button variant="icon" size="sm" aria-label="Close dialog" title="Close" onClick={onClose} disabled={!closable} icon={<X size={16} strokeWidth={1.5} />} />
      </header>
      <div className="overlay__body">{children}</div>
      {footer && <footer className="overlay__foot">{footer}</footer>}
    </Overlay>
  );
}
