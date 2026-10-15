// Pure Today logic for the Triage Split (docs/01_PM_SPEC.md §10.1, D-26..D-28): chip scopes, the strict
// top-10 list, ?show= parsing, deterministic why-it-is-here sentences and key facts. No React here.
import type { QueueItem } from '../types';
import { formatDate, formatTimestamp, relativeLabel, type TimeDisplay } from './dates';

export const TOP_N = 10;

export type Show = 'top' | 'all' | 't1' | 't2' | 't3' | 't4' | 't5' | 't6';
export const SHOW_VALUES: Show[] = ['top', 't1', 't2', 't3', 't4', 't5', 't6', 'all'];

/** Unknown or missing values fall back to `top` (§10.1). */
export function parseShow(v: string | null | undefined): Show {
  return (SHOW_VALUES as string[]).includes(v ?? '') ? (v as Show) : 'top';
}

/** Chip labels are short forms of the frozen tier labels; tier 6 is "Next 3 days" so it is not confused with the Upcoming tab. */
export const TIER_SHORT: Record<number, string> = {
  1: 'Overdue / critical',
  2: 'Due today',
  3: 'Alerts',
  4: 'Waiting',
  5: 'Upgrades',
  6: 'Next 3 days',
};

export interface ChipDef {
  id: Show;
  label: string;
  /** count of the FULL scope, never capped (min(10, length) for Top 10) */
  count: number;
  disabled: boolean;
}

export function tierCounts(queue: QueueItem[]): Record<number, number> {
  const c: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 };
  for (const i of queue) if (i.tier != null) c[i.tier] = (c[i.tier] ?? 0) + 1;
  return c;
}

export function buildChips(queue: QueueItem[]): ChipDef[] {
  const c = tierCounts(queue);
  const top = Math.min(TOP_N, queue.length);
  return [
    { id: 'top', label: 'Top 10', count: top, disabled: top === 0 },
    ...[1, 2, 3, 4, 5, 6].map((t): ChipDef => ({ id: `t${t}` as Show, label: TIER_SHORT[t], count: c[t], disabled: c[t] === 0 })),
    { id: 'all', label: 'All', count: queue.length, disabled: queue.length === 0 },
  ];
}

/** The list for a scope. `queue` order is the API order and is never re-sorted here (AC6). */
export function scopeItems(queue: QueueItem[], show: Show): QueueItem[] {
  if (show === 'top') return queue.slice(0, TOP_N);
  if (show === 'all') return queue;
  const tier = Number(show.slice(1));
  return queue.filter((i) => i.tier === tier);
}

/** A tier chip or Top 10 that has nothing to show falls back to the default so the page never lands on a dead scope. */
export function effectiveShow(show: Show, queue: QueueItem[]): Show {
  const chip = buildChips(queue).find((c) => c.id === show);
  return chip && !chip.disabled ? show : 'top';
}

export interface TierGroup {
  tier: number;
  label: string;
  items: QueueItem[];
  /** 1-based position of the first item within the whole list */
  start: number;
}
export function groupByTier(items: QueueItem[]): TierGroup[] {
  const groups: TierGroup[] = [];
  items.forEach((i, idx) => {
    const g = groups[groups.length - 1];
    if (g && g.tier === i.tier) g.items.push(i);
    else groups.push({ tier: i.tier ?? 0, label: i.tier_label ?? '', items: [i], start: idx + 1 });
  });
  return groups;
}

export const itemKey = (i: Pick<QueueItem, 'kind' | 'id'>) => `${i.kind}:${i.id}`;

/** Selection after the list changes (§10.1): same (kind,id) if still present, else the row now at the same index, clamped. */
export function reconcileSelection(items: QueueItem[], prevKey: string | null, prevIndex: number): number {
  if (items.length === 0) return -1;
  if (prevKey) {
    const at = items.findIndex((i) => itemKey(i) === prevKey);
    if (at >= 0) return at;
  }
  return Math.max(0, Math.min(prevIndex, items.length - 1));
}

/** Tier -> semantic colour class suffix (tier 1 danger, 2 accent, 3 and 4 warning, 5 info, 6 neutral). */
export const TIER_TONE: Record<number, 'danger' | 'accent' | 'warning' | 'info' | 'neutral'> = {
  1: 'danger', 2: 'accent', 3: 'warning', 4: 'warning', 5: 'info', 6: 'neutral',
};

// ------------------------------------------------------------------ copy

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function waitingOn(item: QueueItem): string | null {
  const m = /^Waiting: (.+)$/.exec(item.context ?? '');
  return m ? m[1] : null;
}

function validationReason(item: QueueItem): string | null {
  if (item.status === 'Validation Required') return 'Validation Required';
  if ((item.context ?? '').includes('validation Failed')) return 'validation Failed';
  if (item.status === 'Completed') return 'Completed with validation Pending';
  return null;
}

/** Deterministic why-it-is-here sentence (table in §10.1). A missing value drops its clause. */
export function whySentence(item: QueueItem, today: string): string {
  const date = item.date ? formatDate(item.date.slice(0, 10), today) : null;
  const ago = item.days_delta != null && item.days_delta < 0 ? plural(-item.days_delta, 'day', 'days') : null;
  const prio = item.priority ? ` ${item.priority} priority.` : '';
  switch (item.urgency) {
    case 'critical':
      return `Open Critical alert${item.server_name ? ` on ${item.server_name}` : ''}. Critical alerts always rank first.`;
    case 'overdue':
      if (item.kind === 'server_upgrade') {
        return `Upgrade scheduled${date ? ` for ${date}` : ''}${ago ? `, ${ago} ago,` : ''} and not Completed or Deferred.`;
      }
      return `Overdue${date ? `: due ${date}${ago ? `, ${ago} ago` : ''}` : ''}.${prio}`;
    case 'due_today':
      return `Due today.${prio}`;
    case 'alert':
      return `Open ${item.severity ?? ''}${item.severity ? ' ' : ''}alert${item.server_name ? ` on ${item.server_name}` : ''}.`;
    case 'recovered':
      return 'Alert recovered and waiting to be closed.';
    case 'waiting': {
      const who = waitingOn(item);
      const next = item.date_kind === 'next_update' && date ? date : null;
      return `Waiting${who ? ` on ${who}` : ''}. Next update ${next ?? 'is not set'}.`;
    }
    case 'follow_up':
      return `Next client touch is due${date ? ` ${date}` : ''}.`;
    case 'upgrade':
      if (item.status === 'Exception') return 'Upgrade exception: needs attention at any date.';
      return `Upgrade scheduled${date ? ` for ${date}` : ''}, within 14 days.`;
    case 'validation': {
      const r = validationReason(item);
      return `Upgrade needs validation${r ? `: ${r}` : ''}.`;
    }
    case 'upcoming':
    default:
      if (item.tier === 6) return `Due${date ? ` ${date}` : ''}, within the next 3 days.`;
      return date ? `Coming up on ${date}.` : 'Coming up.';
  }
}

const DATE_KIND_LABEL: Record<string, string> = {
  due: 'Due', next_update: 'Next update', next_contact: 'Next client touch', opened: 'Opened', scheduled: 'Scheduled',
};

export interface Fact { label: string; value: string }

/** Key facts for the detail pane; null facts are omitted, never blank (§10.1). All values come from QueueItem. */
export function keyFacts(item: QueueItem, today: string, tz: TimeDisplay): Fact[] {
  const facts: Fact[] = [];
  facts.push({ label: 'Account', value: item.client_name ?? 'No account' });
  facts.push({ label: 'Type', value: item.type_label });
  if (item.date) {
    const abs = item.date_kind === 'opened' ? formatTimestamp(item.date, tz, today) : formatDate(item.date.slice(0, 10), today);
    const rel = relativeLabel(item.days_delta).text;
    facts.push({ label: DATE_KIND_LABEL[item.date_kind ?? 'due'] ?? 'Date', value: rel ? `${abs} · ${rel}` : abs });
  }
  if (item.tier_label) facts.push({ label: 'Urgency', value: item.tier_label });
  if (item.priority) facts.push({ label: 'Priority', value: item.priority });
  if (item.severity) facts.push({ label: 'Severity', value: item.severity });
  if (item.status && item.kind !== 'client_follow_up') facts.push({ label: 'Status', value: item.status });
  if (item.context) facts.push({ label: 'Context', value: item.context });
  return facts;
}

export function openLabel(item: QueueItem): string {
  switch (item.kind) {
    case 'task': return 'Open task';
    case 'client_follow_up': return 'Open account';
    case 'bams_alert': return 'Open alert';
    default: return 'Open infrastructure';
  }
}

export type WhenTone = 'danger' | 'accent' | 'muted';
/** Right-hand date label of a list row: "3d overdue", "Today", "opened 09:12", "19 Oct". */
export function rowWhen(item: QueueItem, today: string, tz: TimeDisplay): { text: string; tone: WhenTone } {
  if (item.kind === 'bams_alert' && item.date) {
    const stamp = formatTimestamp(item.date, tz, today);
    const sameDay = item.days_delta === 0;
    return { text: `${item.status === 'recovered' ? 'recovered' : 'opened'} ${sameDay ? stamp.slice(7) : stamp.slice(0, 6)}`, tone: 'muted' };
  }
  if (!item.date) return { text: '-', tone: 'muted' };
  const d = item.days_delta;
  const abs = formatDate(item.date.slice(0, 10), today);
  if (d === 0) return { text: 'Today', tone: 'accent' };
  if (d != null && d < 0) {
    if (item.date_kind === 'due' || item.date_kind === 'scheduled') return { text: `${-d}d overdue`, tone: 'danger' };
    return { text: `${item.date_kind === 'next_update' ? 'update ' : 'touch '}${-d}d ago`, tone: 'muted' };
  }
  return { text: abs, tone: 'muted' };
}
