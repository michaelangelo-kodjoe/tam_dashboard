import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Info, Play, Square } from 'lucide-react';
import { PageHeader } from '../../components/ui/Panel';
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
  const st = useQuery('bams-settings', (d) => d.getBamsSettings(), { cache: false });
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
        <div className="bm-sgrid">
          <section className="bm-sec" aria-labelledby="bm-s-poll">
            <h2 id="bm-s-poll">Polling<span>How often BAMS reads metrics and decides what is Live.</span></h2>
            <div className="bm-sec__body">
              <div className="bm-frow">
                <div className="bm-frow__lab"><b>Monitor status</b><span className="muted sm">Persists across restarts. In PROD it starts stopped.</span></div>
                <div className="bm-frow__ctl">
                  <div className="bm-monrow">
                    {m && <span className={cx('badge', running ? 'badge--success' : m.state === 'provider_unavailable' ? 'badge--danger' : 'badge--neutral')}>{running ? 'Running' : m.state === 'stopped' ? 'Stopped' : 'Provider unavailable'}</span>}
                    <Button size="sm" busy={monBusy} busyLabel="Working…" disabled={!m || (!p?.available && !running)} onClick={() => void toggleMonitor()} icon={running ? <Square size={14} strokeWidth={1.5} /> : <Play size={14} strokeWidth={1.5} />}>{running ? 'Stop' : 'Start'}</Button>
                  </div>
                  <span className="help muted sm">
                    {m ? (running ? `Running since ${formatTime(m.started_at, app.time_display)} · last poll ${formatTime(m.last_poll_at, app.time_display, true)} · next ${formatTime(m.next_poll_at, app.time_display, true)}.` : m.state === 'provider_unavailable' ? 'The provider is not connected, so nothing is collected.' : 'Stopped.') : ''}
                  </span>
                </div>
              </div>
              <div className="bm-frow">
                <div className="bm-frow__lab"><b id="bm-poll-lab">Poll interval</b><span className="muted sm">The 15 s page refresh is separate.</span></div>
                <div className="bm-frow__ctl">
                  <Field label="Poll interval" error={fieldError} hint={`At ${formatSeconds(draft.poll_interval_seconds)} polling, Live needs an update within ${formatSeconds(live)}.`} hideLabel>
                    {(f) => (
                      <div className="bm-poll">
                        <Select id={f.id} labelledBy={f.labelId} value={custom ? 'custom' : String(draft.poll_interval_seconds)} options={POLL_OPTIONS} aria-describedby={f.describedBy}
                          onChange={(v) => { if (v === 'custom') { setCustom(true); setCustomText(String(draft.poll_interval_seconds)); } else if (v) { setCustom(false); set({ poll_interval_seconds: Number(v) }); } }} />
                        {custom && (
                          <TextInput aria-label="Custom poll interval in seconds" inputMode="numeric" className="num bm-poll__custom" value={customText} invalid={!!fieldError}
                            onChange={(e) => { setCustomText(e.target.value); const n = Number(e.target.value); set({ poll_interval_seconds: Number.isInteger(n) && n > 0 ? n : 0 }); }} />
                        )}
                        {custom && <span className="muted sm">seconds (30 or more)</span>}
                      </div>
                    )}
                  </Field>
                </div>
              </div>
            </div>
          </section>
          <section className="bm-sec" aria-labelledby="bm-s-notif">
            <h2 id="bm-s-notif">Notifications<span>Where and how alerts reach you.</span></h2>
            <div className="bm-sec__body">
              <div className="bm-frow bm-frow--toggle"><div className="bm-frow__lab"><b>In-app notifications</b><span className="muted sm">Bell and Alerts view. No tab flashing, no title or favicon change.</span></div><Switch checked={draft.in_app_notifications} onChange={(v) => set({ in_app_notifications: v })} aria-label="In-app notifications" /></div>
              <div className="bm-frow bm-frow--toggle"><div className="bm-frow__lab"><b>Desktop notifications (Windows)</b><span className="muted sm">Sent when an alert opens. Each event notifies once.</span></div><Switch checked={draft.desktop_notifications} onChange={(v) => set({ desktop_notifications: v })} aria-label="Desktop notifications" /></div>
              <div className="bm-frow bm-frow--toggle"><div className="bm-frow__lab"><b>Notify when recovered</b><span className="muted sm">Optional, desktop only. Closed is in-app only.</span></div><Switch checked={draft.notify_recovered} onChange={(v) => set({ notify_recovered: v })} aria-label="Notify when recovered" /></div>
              <div className="bm-frow bm-frow--toggle"><div className="bm-frow__lab"><b>Privacy Mode</b><span className="muted sm">Desktop toast says "BAMS alert opened (Critical)" with no account, appliance or value.</span></div><Switch checked={draft.privacy_mode} onChange={(v) => set({ privacy_mode: v })} aria-label="Privacy Mode" /></div>
              <div className="bm-frow">
                <div className="bm-frow__lab"><b>Preview toast</b></div>
                <div className="banner banner--info bm-preview"><Info size={16} strokeWidth={1.5} aria-hidden="true" /><div className="banner__body sm"><b>{draft.privacy_mode ? 'BAMS alert opened (Critical)' : 'Critical opened: CPU utilisation % · Castellan Peak / BPOD-NY-01 · 91.4%'}</b></div></div>
              </div>
              {error && <p role="alert" className="field__error">{error}</p>}
            </div>
            <div className="bm-sec__foot">
              <Button size="sm" onClick={reset} disabled={!dirty || busy}>Reset</Button>
              <Button size="sm" variant="primary" busy={busy} busyLabel="Saving…" disabled={!dirty || draft.poll_interval_seconds === 0} onClick={() => void save()}>Save settings</Button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
