import { useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Button } from '../ui/Button';
import { DataSourceError } from '../../data/DataSource';
import type { FieldErrors } from '../../lib/validate';

export interface SaveFlow {
  busy: boolean;
  fieldErrors: FieldErrors;
  formError: string | null;
  stale: boolean;
  setFieldErrors: (e: FieldErrors) => void;
  clear: () => void;
  /** Runs the save; returns true on success. Maps DataSourceError into the form state. */
  run: (fn: () => Promise<unknown>) => Promise<boolean>;
}

export function useSaveFlow(): SaveFlow {
  const [busy, setBusy] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  return {
    busy, fieldErrors, formError, stale, setFieldErrors,
    clear: () => { setFieldErrors({}); setFormError(null); setStale(false); },
    async run(fn) {
      setBusy(true);
      setFormError(null);
      setStale(false);
      try {
        await fn();
        return true;
      } catch (e) {
        if (e instanceof DataSourceError) {
          if (e.code === 'stale_write') setStale(true);
          else {
            if (e.fields) setFieldErrors(e.fields);
            setFormError(e.fields && Object.keys(e.fields).length ? null : e.message);
            if (e.fields && Object.keys(e.fields).length && e.code !== 'validation_error') setFormError(e.message);
          }
        } else setFormError('Something went wrong. Your input is kept; try again.');
        return false;
      } finally {
        setBusy(false);
      }
    },
  };
}

/** Inline banner for 409 stale_write (guidelines §12). */
export function ConflictBanner({ onReload, onOverwrite, busy }: { onReload: () => void; onOverwrite: () => void; busy?: boolean }) {
  return (
    <div role="alert" className="banner banner--warning">
      <AlertTriangle size={16} strokeWidth={1.5} aria-hidden="true" />
      <div className="banner__body">
        <p className="banner__title">This item changed elsewhere.</p>
        <p className="muted">Reload to discard your edit and see the latest version, or overwrite it with your edit.</p>
      </div>
      <div className="banner__actions">
        <Button size="sm" onClick={onReload} disabled={busy}>Reload</Button>
        <Button size="sm" variant="danger" onClick={onOverwrite} disabled={busy}>Overwrite</Button>
      </div>
    </div>
  );
}

export function FormError({ message }: { message: string | null }) {
  if (!message) return null;
  return <p role="alert" className="form-error">{message}</p>;
}

export function ReadOnlyRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="readonly">
      <span className="label">{label}</span>
      <span className="num">{value}</span>
    </div>
  );
}

/** Focus the first field that has an error (guidelines §7). */
export function focusFirstInvalid(root: HTMLElement | null) {
  const el = root?.querySelector<HTMLElement>('[aria-invalid="true"]');
  el?.focus();
}
