import { useCallback } from 'react';
import { useToast } from '../ui/Toast';
import { useData } from '../../store/DataContext';
import { DataSourceError } from '../../data/DataSource';
import { taskToInput } from '../../lib/tasks';
import type { Task } from '../../types';

/**
 * Mark a task Complete with an Undo toast (reopens to the previous status, guarded by the new row_version).
 * Shared by the task list, the Today work queue rows and the task popup. Resolves true on success.
 */
export function useCompleteTask(): (t: Task) => Promise<boolean> {
  const { ds, bump } = useData();
  const toast = useToast();
  return useCallback(async (t: Task) => {
    try {
      const saved = await ds.saveTask({ ...taskToInput(t), status: 'Complete' });
      bump();
      toast.push({
        kind: 'success', message: 'Task completed', detail: t.task,
        onAction: {
          label: 'Undo',
          run: () => {
            void ds.saveTask({ ...taskToInput(t), status: t.status, expected_row_version: saved.item.row_version }).then(
              () => { bump(); toast.push({ kind: 'info', message: 'Task reopened', detail: t.task }); },
              (e) => toast.push({ kind: 'error', message: 'Could not undo.', detail: e instanceof Error ? e.message : undefined }),
            );
          },
        },
      });
      return true;
    } catch (e) {
      toast.push({ kind: 'error', message: e instanceof DataSourceError && e.code === 'stale_write' ? 'This task changed elsewhere. Reload and try again.' : 'Could not complete the task.', detail: e instanceof Error ? e.message : undefined });
      return false;
    }
  }, [ds, bump, toast]);
}
