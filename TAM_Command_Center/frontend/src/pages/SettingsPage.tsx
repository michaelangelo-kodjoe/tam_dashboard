import { useState } from 'react';
import { DatabaseBackup } from 'lucide-react';
import { PageHeader, Panel } from '../components/ui/Panel';
import { Select } from '../components/ui/Select';
import { SegmentedControl } from '../components/ui/SegmentedControl';
import { Checkbox } from '../components/ui/Checkbox';
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
  const { settings, state, today } = useApp();
  const { ds, bump } = useData();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const logs = useQuery('logs', (d) => d.getLogs(200));
  const backups = useQuery('backups', (d) => d.listBackups());

  const save = async (patch: Partial<Settings>, label: string) => {
    try {
      await ds.saveSettings(patch);
      bump();
      toast.push({ kind: 'success', message: `${label} saved` });
    } catch (e) {
      toast.push({ kind: 'error', message: `Could not save ${label.toLowerCase()}.`, detail: e instanceof Error ? e.message : undefined });
    }
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
  ];
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
            <dt>Database</dt><dd className="mono break">{rt.db_path}</dd>
            <dt>Backup folder</dt><dd className="mono break">{rt.backup_dir ?? '-'}</dd>
            <dt>Today</dt><dd className="num">{state.today}</dd>
          </dl>
        </Panel>

        <Panel title="Data" className="settings__panel settings__wide" actions={<Button size="sm" variant="primary" busy={busy} busyLabel="Backing up…" onClick={() => void backupNow()} icon={<DatabaseBackup size={16} strokeWidth={1.5} />}>Create backup now</Button>}>
          {backups.loading && <SkeletonRows rows={3} label="Loading backups" />}
          {backups.error ? <ErrorBanner error={backups.error} onRetry={backups.reload} title="Could not load backups" /> : null}
          {backups.data && <DataTable caption="Most recent backups" columns={bcols} rows={backups.data} rowKey={(b) => b.name} empty={<EmptyState>No backups yet.</EmptyState>} />}
        </Panel>

        <Panel title="Diagnostics" className="settings__panel settings__wide">
          <div className="form form--inline">
            <Field label="Log level">
              {(p) => <Select id={p.id} value={settings.log_level} onChange={(v) => v && void save({ log_level: v as Settings['log_level'] }, 'Log level')} options={[{ value: 'INFO', label: 'INFO' }, { value: 'DEBUG', label: 'DEBUG' }]} />}
            </Field>
          </div>
          <h3 className="label logs__title">Recent log</h3>
          {logs.loading && <SkeletonRows rows={3} label="Loading log" />}
          {logs.error ? <ErrorBanner error={logs.error} onRetry={logs.reload} title="Could not load the log" /> : null}
          {logs.data && <pre className="logs mono" tabIndex={0} aria-label="Recent log lines">{logs.data.length ? logs.data.join('\n') : 'No log lines yet.'}</pre>}
        </Panel>
      </div>
    </div>
  );
}
