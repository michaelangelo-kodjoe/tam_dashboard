import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, DatabaseBackup, Upload } from 'lucide-react';
import { Dialog } from '../ui/Dialog';
import { Button } from '../ui/Button';
import { Field, TextInput } from '../ui/Fields';
import { DataSourceError } from '../../data/DataSource';
import { useData } from '../../store/DataContext';
import { COUNT_LABELS, reloader } from '../../lib/portability';
import { formatTimestamp } from '../../lib/dates';
import { DB_COUNT_KEYS, type DbRestorePreview, type DbRestoreResult } from '../../portTypes';
import { errText } from '../../pages/bams/common';

type Phase = 'choose' | 'loading' | 'preview' | 'restoring' | 'done' | 'failed' | 'unknown';
export const AUTO_RELOAD_MS = 5000;

const NOT_BUILT = 'Database restore is not available in this build yet. Nothing was changed.';
function message(e: unknown): string {
  if (e instanceof DataSourceError && (e.code === 'not_implemented' || e.status === 501)) return NOT_BUILT;
  return errText(e);
}

/** Restore database (D-136..D-142): replaces everything. Staged preview, typed RESTORE, progress, then Reload. */
export function RestoreDatabaseDialog({ backupName, onClose }: { backupName?: string; onClose: () => void }) {
  const { ds } = useData();
  const [phase, setPhase] = useState<Phase>(backupName ? 'loading' : 'choose');
  const [preview, setPreview] = useState<DbRestorePreview | null>(null);
  const [typed, setTyped] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<DbRestoreResult | null>(null);
  const [failure, setFailure] = useState<{ state: string; backup: string | null; text: string } | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const previewId = useRef<string | null>(null);
  const finished = useRef(false);

  const stage = useCallback(async (fn: () => Promise<DbRestorePreview>) => {
    setPhase('loading'); setError(null);
    try { const p = await fn(); previewId.current = p.restore_id; setPreview(p); setPhase('preview'); } catch (e) { setError(message(e)); setPhase(backupName ? 'failed' : 'choose'); setFailure(backupName ? { state: 'none', backup: null, text: message(e) } : null); }
  }, [backupName]);

  useEffect(() => { if (backupName) void stage(() => ds.previewBackupRestore(backupName)); }, [backupName, ds, stage]);

  // leaving a staged preview without applying cancels the session (best effort)
  const close = () => {
    if (previewId.current && !finished.current) void ds.cancelDatabaseRestore(previewId.current).catch(() => undefined);
    onClose();
  };

  useEffect(() => {
    if (phase !== 'done' && phase !== 'unknown') return;
    const h = setTimeout(() => reloader.reload(), AUTO_RELOAD_MS);
    return () => clearTimeout(h);
  }, [phase]);

  const word = preview?.confirm_word ?? 'RESTORE';
  const apply = async () => {
    if (!preview || typed !== word) return;
    setPhase('restoring'); setError(null); finished.current = true;
    try {
      const r = await ds.applyDatabaseRestore({ restore_id: preview.restore_id, confirm: typed });
      setResult(r); setPhase('done');
    } catch (e) {
      if (e instanceof DataSourceError && e.code === 'restore_failed') {
        const d = (e.details ?? {}) as { state?: string; backup?: string | { name?: string } };
        const b = typeof d.backup === 'string' ? d.backup : d.backup?.name ?? null;
        setFailure({ state: d.state ?? 'unchanged', backup: b, text: e.message });
        setPhase('failed');
      } else if (e instanceof DataSourceError && (e.code === 'network' || e.code === 'restoring' || e.status === 503)) {
        for (let i = 0; i < 60; i++) {
          await new Promise((r) => setTimeout(r, 1000));
          try { await ds.getRuntime(); break; } catch { /* still restoring */ }
        }
        setPhase('unknown');
      } else {
        finished.current = false;
        setError(message(e)); setPhase('preview');
      }
    }
  };

  const busyNow = phase === 'restoring' || phase === 'loading';
  const title = backupName ? 'Restore this backup' : 'Restore database';
  let footer;
  if (phase === 'done' || phase === 'unknown' || phase === 'failed' && failure?.state !== 'none') footer = <><span className="pt-spacer" /><Button variant="primary" onClick={() => reloader.reload()}>Reload app</Button></>;
  else if (phase === 'restoring') footer = null;
  else footer = (
    <>
      <span className="pt-spacer" /><Button onClick={close}>Cancel</Button>
      {phase === 'preview' && <Button variant="danger" disabled={typed !== word} onClick={() => void apply()}>Restore database</Button>}
    </>
  );

  return (
    <Dialog title={title} width={760} onClose={phase === 'restoring' ? () => undefined : close} closable={!busyNow} closeOnScrim={false} footer={footer} role={phase === 'restoring' ? 'alertdialog' : 'dialog'}>
      {phase === 'choose' && (
        <div className="pt-restore">
          <p>Choose a database file: a Database export or a safety backup (.db). Nothing is changed until you confirm on the next screen.</p>
          <input ref={input} type="file" accept=".db,.sqlite,.sqlite3" className="sr-only" aria-label="Choose a database file" onChange={(e) => { const f = e.target.files?.[0]; if (f) void stage(() => ds.inspectDatabaseRestore(f)); if (input.current) input.current.value = ''; }} />
          <Button icon={<Upload size={16} strokeWidth={1.5} />} onClick={() => input.current?.click()}>Choose database file</Button>
          {error && <p role="alert" className="field__error pt-err">{error}</p>}
        </div>
      )}
      {phase === 'loading' && <p role="status" className="muted">Checking the file. Nothing is changed.</p>}
      {phase === 'failed' && failure?.state === 'none' && <p role="alert" className="field__error">{failure.text}</p>}
      {phase === 'preview' && preview && (
        <div className="pt-restore">
          <p className="muted sm">{preview.source.kind === 'backup' ? 'Backup' : 'File'}: <span className="mono">{preview.source.name}</span></p>
          <div className="panel table-scroll">
            <table className="table table--compact">
              <caption className="sr-only">In the file compared with the current database</caption>
              <thead><tr><th scope="col"> </th><th scope="col" className="is-right">In the file</th><th scope="col" className="is-right">In the current database</th></tr></thead>
              <tbody>
                <tr><th scope="row">Schema version</th><td className="is-right num">{preview.file.schema_version}{preview.file.will_upgrade_from != null && <span className="muted sm"> (upgraded from {preview.file.will_upgrade_from})</span>}</td><td className="is-right num">{preview.current.schema_version}</td></tr>
                <tr><th scope="row">Latest activity</th><td className="is-right num">{preview.file.latest_activity ? formatTimestamp(preview.file.latest_activity, 'local') : 'Unknown'}</td><td className="is-right num">{preview.current.latest_activity ? formatTimestamp(preview.current.latest_activity, 'local') : 'Unknown'}</td></tr>
                <tr><th scope="row">Channel</th><td className="is-right">{preview.file.channel ?? '-'}</td><td className="is-right">{preview.current.channel ?? '-'}</td></tr>
                {DB_COUNT_KEYS.map((k) => {
                  const fewer = preview.fewer.includes(k);
                  return (
                    <tr key={k} className={fewer ? 'pt-fewer' : undefined}>
                      <th scope="row">{COUNT_LABELS[k]}</th>
                      <td className="is-right num">{preview.file.counts[k]}{fewer && <span className="warning-text sm"> fewer</span>}</td>
                      <td className="is-right num">{preview.current.counts[k]}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="pt-danger" role="alert"><AlertTriangle size={16} strokeWidth={1.5} aria-hidden="true" /> {preview.warning}</p>
          <Field label={`Type ${word} to continue`} error={error ?? undefined}>
            {(p) => <TextInput id={p.id} autoComplete="off" spellCheck={false} value={typed} onChange={(e) => { setTyped(e.target.value); setError(null); }} onKeyDown={(e) => { if (e.key === 'Enter' && typed === word) { e.preventDefault(); void apply(); } }} invalid={p.invalid} aria-describedby={p.describedBy} />}
          </Field>
        </div>
      )}
      {phase === 'restoring' && (
        <div role="status" className="pt-progress"><DatabaseBackup size={20} strokeWidth={1.5} aria-hidden="true" /> <b>Restoring… do not close this window.</b>
          <p className="muted sm">The app is replacing the database. It pauses for a few seconds and then reloads.</p></div>
      )}
      {phase === 'done' && result && (
        <div className="pt-restore">
          <div role="status" className="banner pt-okbanner"><div className="banner__body"><b>Database restored</b><div className="muted sm">The app reloads in {AUTO_RELOAD_MS / 1000} seconds, or press Reload app.</div></div></div>
          <dl className="rc-dl rc-dl--wide">
            <dt>Safety backup</dt><dd className="mono break">{result.backup.name} (kept in the Backups list)</dd>
            <dt>Schema version</dt><dd className="num">{result.schema_version}</dd>
            {DB_COUNT_KEYS.filter((k) => result.counts[k] !== undefined).map((k) => <><dt key={`t${k}`}>{COUNT_LABELS[k]}</dt><dd key={`d${k}`} className="num">{result.counts[k]}</dd></>)}
          </dl>
        </div>
      )}
      {phase === 'unknown' && (
        <div role="status" className="banner pt-okbanner"><div className="banner__body"><b>The app is back.</b><div className="muted sm">The answer was lost while it restarted. Reload to see the current data; the safety backup is in the Backups list. Reloading in {AUTO_RELOAD_MS / 1000} seconds.</div></div></div>
      )}
      {phase === 'failed' && failure && failure.state !== 'none' && (
        <div role="alert" className="banner banner--warning"><div className="banner__body">
          <b>{failure.state === 'safety_backup' ? `Restored from safety backup ${failure.backup ?? ''}`.trim() : 'Your data was not changed'}</b>
          <div className="sm">{failure.text}</div></div></div>
      )}
    </Dialog>
  );
}
