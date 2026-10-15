import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Info, Play, Square } from 'lucide-react';
import { PageHeader, Panel } from '../../components/ui/Panel';
import { Button } from '../../components/ui/Button';
import { Select } from '../../components/ui/Select';
import { Field, TextInput } from '../../components/ui/Fields';
import { Switch } from '../../components/ui/Switch';
import { ErrorBanner, SkeletonRows } from '../../components/ui/Feedback';
import { useToast } from '../../components/ui/Toast';
import { DataSourceError } from '../../data/DataSource';
import { useApp, useData, useQuery } from '../../store/DataContext';
import { useDocumentTitle } from '../../lib/hooks';
import { formatSeconds, formatTime } from '../../lib/bams';
import { cx } from '../../lib/cx';
import type { BamsSettings } from '../../bamsTypes';
import { errText } from './common';

const PRESETS = [60, 120, 300, 600];
const POLL_OPTIONS = [
  { value: '60', label: '60 seconds' }, { value: '120', label: '2 minutes' }, { value: '300', label: '5 minutes' }, { value: '600', label: '10 minutes' },
  { value: 'custom', label: 'Custom (30 s or more)' },
];

/** BAMS monitor and notification settings (mockup 07). */
export function BamsSettingsPage() {
  useDocumentTitle('BAMS settings');
  const { ds, bump } = useData();
  const { settings: app } = useApp();
  const toast = useToast();
  const st = useQuery('bams-settings', (d) => d.getBamsSettings());
  const mon = useQuery('bams-monitor', (d) => d.getBamsMonitor());
  const [draft, setDraft] = useState<BamsSettings | null>(null);
  const [custom, setCustom] = useState(false);
  const [customText, setCustomText] = useState('');
  const [busy, setBusy] = useState(false);
  const [monBusy, setMonBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);

  useEffect(() => {
    if (st.data && !draft) { setDraft(st.data); setCustom(!PRESETS.includes(st.data.poll_interval_seconds)); setCustomText(String(st.data.poll_interval_seconds)); }
  }, [st.data, draft]);

  const dirty = !!(draft && st.data && (Object.keys(draft) as (keyof BamsSettings)[]).some((k) => draft[k] !== st.data![k]));
  const set = (p: Partial<BamsSettings>) => { setDraft((d) => (d ? { ...d, ...p } : d)); setFieldError(null); setError(null); };

  const reset = () => { if (st.data) { setDraft(st.data); setCustom(!PRESETS.includes(st.data.poll_interval_seconds)); setCustomText(String(st.data.poll_interval_seconds)); setFieldError(null); setError(null); } };
  const save = async () => {
    if (!draft || !st.data) return;
    const patch: Partial<BamsSettings> = {};
    (Object.keys(draft) as (keyof BamsSettings)[]).forEach((k) => { if (draft[k] !== st.data![k]) (patch as Record<string, unknown>)[k] = draft[k]; });
    setBusy(true);
    try {
      const saved = await ds.saveBamsSettings(patch);
      setDraft(saved);
      st.reload(); mon.reload(); bump();
      toast.push({ kind: 'success', message: 'BAMS settings saved' });
    } catch (e) {
      if (e instanceof DataSourceError && e.fields?.poll_interval_seconds) setFieldError(e.fields.poll_interval_seconds); else setError(errText(e));
    } finally { setBusy(false); }
  };
  const toggleMonitor = async () => {
    if (!mon.data) return;
    setMonBusy(true);
    try { await ds.setBamsMonitor(mon.data.monitor.state !== 'running'); mon.reload(); bump(); }
    catch (e) { toast.push({ kind: 'error', message: 'Could not change the monitor.', detail: errText(e) }); }
    finally { setMonBusy(false); }
  };

  const m = mon.data?.monitor;
  const p = mon.data?.provider;
  const running = m?.state === 'running';
  const live = draft ? Math.max(draft.poll_interval_seconds + 15, 75) : 75;

  return (
    <div className="page bm-page">
      <PageHeader title="BAMS settings" meta="Monitor and notifications" actions={<Link to="/bams" className="btn btn--ghost btn--md"><span className="btn__label">Back to dashboard</span></Link>} />
      {(st.loading || mon.loading) && <SkeletonRows rows={5} label="Loading settings" />}
      {st.error ? <ErrorBanner error={st.error} onRetry={st.reload} title="Could not load settings" /> : null}
      {draft && (
        <div className="bm-g2">
          <Panel title="Monitor">
            <div className="bm-tog">
              <div>
                <div>Monitor status</div>
                <div className="muted sm">
                  {m ? (running ? `Running since ${formatTime(m.started_at, app.time_display)} · last poll ${formatTime(m.last_poll_at, app.time_display, true)} · next ${formatTime(m.next_poll_at, app.time_display, true)}. ` : m.state === 'provider_unavailable' ? 'The provider is not connected, so nothing is collected. ' : 'Stopped. ')
                    : ''}Persists across restarts. In PROD it starts stopped.
                </div>
              </div>
              {m && <span className={cx('badge', running ? 'badge--success' : m.state === 'provider_unavailable' ? 'badge--danger' : 'badge--neutral')}>{running ? 'Running' : m.state === 'stopped' ? 'Stopped' : 'Provider unavailable'}</span>}
              <Button size="sm" busy={monBusy} busyLabel="Working…" disabled={!m || (!p?.available && !running)} onClick={() => void toggleMonitor()} icon={running ? <Square size={14} strokeWidth={1.5} /> : <Play size={14} strokeWidth={1.5} />}>{running ? 'Stop' : 'Start'}</Button>
            </div>
            <Field label="Poll interval" error={fieldError} hint={`Options: 60 s, 2 min, 5 min, 10 min, custom (30 s or more). The 15 s page refresh is separate. At ${formatSeconds(draft.poll_interval_seconds)} polling, Live needs an update within ${formatSeconds(live)}.`}>
              {(f) => (
                <div className="bm-poll">
                  <Select id={f.id} labelledBy={f.labelId} value={custom ? 'custom' : String(draft.poll_interval_seconds)} options={POLL_OPTIONS} aria-describedby={f.describedBy}
                    onChange={(v) => { if (v === 'custom') { setCustom(true); setCustomText(String(draft.poll_interval_seconds)); } else if (v) { setCustom(false); set({ poll_interval_seconds: Number(v) }); } }} />
                  {custom && (
                    <TextInput aria-label="Custom poll interval in seconds" inputMode="numeric" className="num bm-poll__custom" value={customText} invalid={!!fieldError}
                      onChange={(e) => { setCustomText(e.target.value); const n = Number(e.target.value); set({ poll_interval_seconds: Number.isInteger(n) && n > 0 ? n : 0 }); }} />
                  )}
                  {custom && <span className="muted sm">seconds</span>}
                </div>
              )}
            </Field>
          </Panel>
          <Panel title="Notifications">
            <div className="bm-tog"><div><div id="bm-n1">In-app notifications</div><div className="muted sm">Bell and Alerts view. No tab flashing, no title or favicon change.</div></div><Switch checked={draft.in_app_notifications} onChange={(v) => set({ in_app_notifications: v })} aria-label="In-app notifications" /></div>
            <div className="bm-tog"><div><div>Desktop notifications (Windows)</div><div className="muted sm">Sent when an alert opens. Each event notifies once.</div></div><Switch checked={draft.desktop_notifications} onChange={(v) => set({ desktop_notifications: v })} aria-label="Desktop notifications" /></div>
            <div className="bm-tog"><div><div>Notify when recovered</div><div className="muted sm">Optional, desktop only. Closed is in-app only.</div></div><Switch checked={draft.notify_recovered} onChange={(v) => set({ notify_recovered: v })} aria-label="Notify when recovered" /></div>
            <div className="bm-tog"><div><div>Privacy Mode</div><div className="muted sm">Desktop toast says "BAMS alert opened (Critical)" with no account, appliance or value.</div></div><Switch checked={draft.privacy_mode} onChange={(v) => set({ privacy_mode: v })} aria-label="Privacy Mode" /></div>
            <div className="banner banner--info bm-preview"><Info size={16} strokeWidth={1.5} aria-hidden="true" /><div className="banner__body sm">Preview toast: <b>{draft.privacy_mode ? 'BAMS alert opened (Critical)' : 'Critical opened: CPU utilisation % · Castellan Peak / BPOD-NY-01 · 91.4%'}</b></div></div>
            <p className="help muted sm">Windows delivery is unverified until tested on Windows. DEV records the attempt as "dev: not displayed".</p>
            {error && <p role="alert" className="field__error">{error}</p>}
            <div className="bm-ruleform__foot">
              <Button size="sm" onClick={reset} disabled={!dirty || busy}>Reset</Button>
              <Button size="sm" variant="primary" busy={busy} busyLabel="Saving…" disabled={!dirty || draft.poll_interval_seconds === 0} onClick={() => void save()}>Save settings</Button>
            </div>
          </Panel>
        </div>
      )}
    </div>
  );
}
