import { useId, useState, type ReactNode } from 'react';
import { Dialog } from './Dialog';
import { Button } from './Button';

export interface ConfirmDialogProps {
  title: string;
  /** Bold object name */
  objectName?: string;
  description?: ReactNode;
  confirmLabel: string;
  /** danger (default) or primary-style for "Discard changes?" with Keep editing focused */
  tone?: 'danger' | 'neutral';
  cancelLabel?: string;
  cancelVariant?: 'secondary' | 'primary';
  /** If set, the user must type this exact text to enable the confirm button (account delete). */
  typeToConfirm?: string;
  busy?: boolean;
  error?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}

/** Cancel is focused by default (the least-destructive button). */
export function ConfirmDialog({
  title, objectName, description, confirmLabel, tone = 'danger', cancelLabel = 'Cancel', cancelVariant = 'secondary', typeToConfirm, busy, error, onConfirm, onCancel,
}: ConfirmDialogProps) {
  const [typed, setTyped] = useState('');
  const inputId = useId();
  const ok = !typeToConfirm || typed === typeToConfirm;
  return (
    <Dialog
      title={title}
      width={440}
      role="alertdialog"
      onClose={onCancel}
      closable={!busy}
      footer={
        <>
          <Button variant={cancelVariant} data-autofocus onClick={onCancel} disabled={busy}>{cancelLabel}</Button>
          <Button variant={tone === 'danger' ? 'danger' : 'primary'} onClick={onConfirm} disabled={!ok} busy={busy} busyLabel="Working…">
            {confirmLabel}
          </Button>
        </>
      }
    >
      {objectName && <p className="confirm__name">{objectName}</p>}
      <div className="confirm__text">{description}</div>
      {typeToConfirm && (
        <div className="field">
          <label htmlFor={inputId} className="field__label">Type <strong className="mono">{typeToConfirm}</strong> to confirm</label>
          <input id={inputId} className="input" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} />
        </div>
      )}
      {error && <p role="alert" className="field__error">{error}</p>}
    </Dialog>
  );
}
