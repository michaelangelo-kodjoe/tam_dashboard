import { PageHeader } from '../components/ui/Panel';
import { TaskList } from '../components/tasks/TaskList';
import { useDocumentTitle } from '../lib/hooks';

export function TasksPage() {
  useDocumentTitle('Tasks');
  return (
    <div className="page">
      <PageHeader title="Tasks" meta="All accounts" />
      <TaskList caption="All tasks" />
    </div>
  );
}
