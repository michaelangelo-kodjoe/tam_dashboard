import { useNavigate, useLocation } from 'react-router-dom';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { useUI } from '../../store/UIContext';
import { useApp } from '../../store/DataContext';

/** "Create a task from this action item?" after a note with action items is saved. The note is already saved; No changes nothing. */
export function ActionItemPrompt() {
  const { actionQueue: q, answerActionItem } = useUI();
  const { accountById } = useApp();
  const navigate = useNavigate();
  const loc = useLocation();
  if (!q || q.phase !== 'ask') return null;
  const item = q.items[q.index];
  const acct = accountById(q.clientId)?.name;
  const yes = () => {
    answerActionItem(true);
    const p = new URLSearchParams(loc.search);
    p.delete('note'); p.delete('type'); p.delete('edit');
    p.set('task', 'new');
    navigate({ pathname: loc.pathname, search: `?${p.toString()}`, hash: loc.hash });
  };
  return (
    <ConfirmDialog
      key={`${q.index}`}
      title="Create a task from this action item?"
      objectName={item}
      description={<>{acct ? <>Account: {acct}. </> : null}{q.items.length > 1 ? <span className="muted">Action item {q.index + 1} of {q.items.length}</span> : null}</>}
      confirmLabel="Yes, create task" cancelLabel="No" tone="neutral"
      onConfirm={yes} onCancel={() => answerActionItem(false)}
    />
  );
}
