import type { QueueItem } from '../types';

export type WorkspaceTab = 'overview' | 'tasks' | 'activity' | 'infrastructure' | 'contacts';
export const WORKSPACE_TABS: WorkspaceTab[] = ['overview', 'tasks', 'activity', 'infrastructure', 'contacts'];

export function accountPath(id: string, tab: WorkspaceTab = 'overview', query?: Record<string, string>): string {
  const q = query && Object.keys(query).length ? `?${new URLSearchParams(query).toString()}` : '';
  return `/accounts/${id}/${tab}${q}`;
}

/** Queue/Upcoming item -> underlying object (docs/01_PM_SPEC.md §4.2). */
export function queueTarget(i: QueueItem): string {
  switch (i.kind) {
    case 'task':
      return i.client_id ? accountPath(i.client_id, 'tasks', { task: i.id }) : `/tasks?task=${encodeURIComponent(i.id)}`;
    case 'client_follow_up':
      return `${accountPath(i.client_id!, 'overview')}#next-touch`;
    case 'bams_alert':
      // Today row -> the alert in the BAMS Alerts view (contract §11.12 item 7)
      return `/bams/alerts?event=${encodeURIComponent(i.id)}`;
    case 'server_upgrade':
      return accountPath(i.client_id!, 'infrastructure', i.server_name ? { server: i.server_name } : undefined);
  }
}

/** Remove one query param, preserving the rest. */
export function withoutParam(search: string, key: string): string {
  const p = new URLSearchParams(search);
  p.delete(key);
  const s = p.toString();
  return s ? `?${s}` : '';
}

/** Current location with ?task=<id> set (opens the task drawer; keeps other params). */
export function taskDrawerLink(pathname: string, search: string, id: string): string {
  const p = new URLSearchParams(search);
  p.set('task', id);
  return `${pathname}?${p.toString()}`;
}
