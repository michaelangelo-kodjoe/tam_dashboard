import { useState } from 'react';
import { DatabaseBackup, Download, FileSpreadsheet, RotateCcw, Upload } from 'lucide-react';
import { PageHeader, Panel } from '../components/ui/Panel';
import { Select } from '../components/ui/Select';
import { SegmentedControl } from '../components/ui/SegmentedControl';
import { Checkbox } from '../components/ui/Checkbox';
import { CollapsiblePanel } from '../components/ui/CollapsiblePanel';
import { RestoreFileDialog } from '../components/portability/RestoreFileDialog';
import { RestoreDatabaseDialog } from '../components/portability/RestoreDatabaseDialog';
import { saveFile } from '../lib/download';
import { Button } from '../components/ui/Button';
import { DataTable, type Column } from '../components/ui/DataTable';
import { EmptyState, ErrorBanner, SkeletonRows } from '../components/ui/Feedback';
import { Field } from '../components/ui/Fields';
import { useToast } from '../components/ui/Toast';
import { useApp, useData, useQuery } from '../store/DataContext';
import type { BackupInfo, Settings } from '../types';
import { formatTimestamp } from '../lib/dates';
import { useDocumentTitle } from '../lib/hooks';

function sizeText(n: number): string {
  return n >= 1_048_576 ? `${(n / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}

export function SettingsPage() {
  useDocumentTitle('Settings');
  const { settings, state } = useApp();
  const { ds, bump } = useData();
  const toast = useToast();

  const save = async (patch: Partial<Settings>, label: string) => {
    try {
      await ds.saveSettings(patch);
      bump();
      toast.push({ kind: 'success', message: `${label} saved` });
    } catch (e) {
      toast.push({ kind: 'error', message: `Could not save ${label.toLowerCase()}.`, detail: e instanceof Error ? e.message : undefined });
    }
  };

  const rt = state.runtime;

  return (
    <div className="page settings">
      <PageHeader title="Settings" />
      <div className="settings__grid">
        <Panel title="General" className="settings__panel">
          <div className="form">
            <Field label="Default landing page">
              {(p) => <Select id={p.id} value={settings.default_landing} onChange={(v) => v && void save({ default_landing: v as Settings['default_landing'] }, 'Landing page')} options={[{ value: 'today', label: 'Today' }, { value: 'accounts', label: 'Accounts' }, { value: 'tasks', label: 'Tasks' }]} />}
            </Field>
            <div className="field">
              <span className="field__label">Time display</span>
              <SegmentedControl<Settings['time_display']> label="Time display" value={settings.time_display} onChange={(v) => void save({ time_display: v }, 'Time display')} options={[{ value: 'local', label: 'Local' }, { value: 'gmt', label: 'GMT' }]} />
            </div>
            <Field label="Dashboard auto-refresh">
              {(p) => <Select id={p.id} value={settings.auto_refresh_minutes} onChange={(v) => v && void save({ auto_refresh_minutes: v as Settings['auto_refresh_minutes'] }, 'Auto-refresh')} options={[{ value: 'off', label: 'Off' }, { value: '1', label: 'Every 1 minute' }, { value: '5', label: 'Every 5 minutes' }, { value: '15', label: 'Every 15 minutes' }]} />}
            </Field>
            <Checkbox label="Open the browser on start (used by the launcher)" checked={settings.open_browser_on_start} onChange={(e) => void save({ open_browser_on_start: e.target.checked }, 'Setting')} />
          </div>
        </Panel>

        <Panel title="Runtime" className="settings__panel">
          <dl className="rc-dl rc-dl--wide">
            <dt>Mode</dt><dd>{rt.mode}</dd>
            <dt>Data source</dt><dd>{rt.source === 'mock' ? 'In-memory mock data (nothing is saved)' : 'Live API'}</dd>
            <dt>Version</dt><dd className="mono">{rt.version}</dd>
            <dt>Schema version</dt><dd className="mono">{rt.schema_version}</dd>
            <dt>Database</dt><dd className="mono break">{rt.db_name ?? '-'}</dd>
            <dt>Database file</dt><dd className="mono break">{rt.db_path}</dd>
            <dt>Backup folder</dt><dd className="mono break">{rt.backup_dir ?? '-'}</dd>
            <dt>Today</dt><dd className="num">{state.today}</dd>
          </dl>
        </Panel>

        <CollapsiblePanel id="settings-data" title="Data" hint="Backups" className="settings__wide">
          {() => <DataSection />}
        </CollapsiblePanel>

        <CollapsiblePanel id="settings-logging" title="Logging" hint="Log level and recent log" className="settings__wide">
          {() => <LoggingSection />}
        </CollapsiblePanel>
      </div>
    </div>
  );
}

/** Drop-in container for the Data section (backups now; export/restore land here in Run 6). Loads only when opened. */
function DataSection() {
  const { settings, today } = useApp();
  const { ds, bump } = useData();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const backups = useQuery('backups', (d) => d.listBackups());
  const [dlg, setDlg] = useState<null | { kind: 'file' } | { kind: 'db'; backup?: string }>(null);
  const [dl, setDl] = useState<string | null>(null);
  const download = async (what: 'excel' | 'database') => {
    setDl(what);
    try {
      const f = await (what === 'excel' ? ds.exportExcel() : ds.exportDatabase());
      saveFile(f);
      toast.push({ kind: 'success', message: what === 'excel' ? 'Excel export downloaded' : 'Database copy downloaded', detail: f.filename });
    } catch (e) {
      toast.push({ kind: 'error', message: what === 'excel' ? 'Could not create the Excel export.' : 'Could not create the database copy.', detail: e instanceof Error ? e.message : undefined });
    } finally { setDl(null); }
  };
  const backupNow = async () => {
    setBusy(true);
    try {
      const b = await ds.createBackup();
      bump();
      toast.push({ kind: 'success', message: 'Backup created', detail: b.name });
      backups.reload();
    } catch (e) {
      toast.push({ kind: 'error', message: 'Backup failed.', detail: e instanceof Error ? e.message : undefined });
    } finally {
      setBusy(false);
    }
  };

  const bcols: Column<BackupInfo>[] = [
    { key: 'name', header: 'Name', mono: true, cell: (b) => b.name },
    { key: 'reason', header: 'Reason', cell: (b) => b.reason },
    { key: 'size', header: 'Size', align: 'right', cell: (b) => sizeText(b.size_bytes) },
    { key: 'time', header: 'Created', align: 'right', cell: (b) => formatTimestamp(b.created_at, settings.time_display, today) },
    { key: 'act', header: 'Restore', align: 'right', cell: (b) => <Button size="sm" variant="ghost" icon={<RotateCcw size={14} strokeWidth={1.5} />} aria-label={`Restore this backup: ${b.name}`} onClick={() => setDlg({ kind: 'db', backup: b.name })}>Restore this backup</Button> },
  ];
  return (
    <div className="settings__data">
      <ul className="pt-rows" aria-label="Export and restore">
        <li className="pt-row">
          <div><b>Download Excel export</b><p className="muted sm">Accounts, contacts, tasks, notes, appliances and Operations in one workbook.</p></div>
          <Button busy={dl === 'excel'} busyLabel="Preparing…" icon={<FileSpreadsheet size={16} strokeWidth={1.5} />} onClick={() => void download('excel')}>Export to Excel</Button>
        </li>
        <li className="pt-row">
          <div><b>Download database copy</b><p className="muted sm">A complete copy of the database. It contains all your data.</p></div>
          <Button busy={dl === 'database'} busyLabel="Preparing…" icon={<Download size={16} strokeWidth={1.5} />} onClick={() => void download('database')}>Export database</Button>
        </li>
        <li className="pt-row">
          <div><b>Restore from file</b><p className="muted sm">Add what is missing from an Excel export or CSV files. Existing data is never overwritten.</p></div>
          <Button icon={<Upload size={16} strokeWidth={1.5} />} onClick={() => setDlg({ kind: 'file' })}>Restore from file</Button>
        </li>
        <li className="pt-row">
          <div><b>Restore database</b><p className="muted sm">Replace everything with a database file or a backup below. A safety backup is taken first.</p></div>
          <Button icon={<RotateCcw size={16} strokeWidth={1.5} />} onClick={() => setDlg({ kind: 'db' })}>Restore database</Button>
        </li>
      </ul>
      <div className="cpanel__bar">
        <h3 className="label">Backups</h3>
        <span className="ops-spacer" style={{ flex: 1 }} />
        <Button size="sm" variant="primary" busy={busy} busyLabel="Backing up…" onClick={() => void backupNow()} icon={<DatabaseBackup size={16} strokeWidth={1.5} />}>Create backup now</Button>
      </div>
      {backups.loading && <SkeletonRows rows={3} label="Loading backups" />}
      {backups.error ? <ErrorBanner error={backups.error} onRetry={backups.reload} title="Could not load backups" /> : null}
      {backups.data && <DataTable caption="Most recent backups" columns={bcols} rows={backups.data} rowKey={(b) => b.name} empty={<EmptyState>No backups yet.</EmptyState>} />}
      {dlg?.kind === 'file' && <RestoreFileDialog onClose={() => { setDlg(null); backups.reload(); }} />}
      {dlg?.kind === 'db' && <RestoreDatabaseDialog backupName={dlg.backup} onClose={() => setDlg(null)} />}
    </div>
  );
}

function LoggingSection() {
  const { settings } = useApp();
  const { ds, bump } = useData();
  const toast = useToast();
  const logs = useQuery('logs', (d) => d.getLogs(200));
  const save = async (patch: Partial<Settings>, label: string) => {
    try {
      await ds.saveSettings(patch);
      bump();
      toast.push({ kind: 'success', message: `${label} saved` });
    } catch (e) {
      toast.push({ kind: 'error', message: `Could not save ${label.toLowerCase()}.`, detail: e instanceof Error ? e.message : undefined });
    }
  };
  return (
    <>
      <div className="form form--inline">
        <Field label="Log level">
          {(p) => <Select id={p.id} value={settings.log_level} onChange={(v) => v && void save({ log_level: v as Settings['log_level'] }, 'Log level')} options={[{ value: 'INFO', label: 'INFO' }, { value: 'DEBUG', label: 'DEBUG' }]} />}
        </Field>
      </div>
      <h3 className="label logs__title">Recent log</h3>
      {logs.loading && <SkeletonRows rows={3} label="Loading log" />}
      {logs.error ? <ErrorBanner error={logs.error} onRetry={logs.reload} title="Could not load the log" /> : null}
      {logs.data && <pre className="logs mono" tabIndex={0} aria-label="Recent log lines">{logs.data.length ? logs.data.join('\n') : 'No log lines yet.'}</pre>}
    </>
  );
}
