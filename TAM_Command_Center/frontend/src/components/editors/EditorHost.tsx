import { useMatch, useNavigate, useLocation } from 'react-router-dom';
import { TaskDrawer } from './TaskDrawer';
import { TaskViewDialog } from './TaskViewDialog';
import { NoteDrawer } from './NoteDrawer';
import { ContactDrawer } from './ContactDrawer';
import { AccountDrawer } from './AccountDrawer';
import { useApp } from '../../store/DataContext';
import { NOTE_TYPES, type NoteType } from '../../types';
import { withoutParam } from '../../lib/links';

/**
 * Renders the editor drawer named by the URL query (?task= ?note= ?contact= ?account=).
 * The URL reflects the open object so Back closes it (guidelines §10) and deep links work.
 */
export function EditorHost() {
  const loc = useLocation();
  const navigate = useNavigate();
  const match = useMatch('/accounts/:clientId/*');
  const routeClient = match?.params.clientId ?? null;
  const { state } = useApp();
  const q = new URLSearchParams(loc.search);

  const closeParam = (key: string) => () => {
    let s = withoutParam(loc.search, key);
    if (key === 'task') s = withoutParam(s, 'edit');
    if (key === 'note') s = withoutParam(s, 'type');
    navigate({ pathname: loc.pathname, search: s, hash: loc.hash }, { replace: true });
  };

  const task = q.get('task');
  if (task) {
    // opening an existing task shows the read-only popup first; Edit (or ?edit=1) opens the drawer; "new" goes straight to the form
    if (task === 'new' || q.get('edit')) return <TaskDrawer key={task} taskId={task} defaultClientId={routeClient} onClose={closeParam('task')} />;
    const edit = () => { const p = new URLSearchParams(loc.search); p.set('edit', '1'); navigate({ pathname: loc.pathname, search: `?${p.toString()}`, hash: loc.hash }, { replace: true }); };
    return <TaskViewDialog key={task} taskId={task} onClose={closeParam('task')} onEdit={edit} />;
  }

  const note = q.get('note');
  if (note && routeClient) {
    const t = q.get('type');
    const type = (NOTE_TYPES as readonly string[]).includes(t ?? '') ? (t as NoteType) : undefined;
    return <NoteDrawer key={note} noteId={note} clientId={routeClient} newType={type} onClose={closeParam('note')} />;
  }

  const contact = q.get('contact');
  if (contact) {
    const existing = state.contacts.find((c) => c.id === contact);
    const cid = existing?.client_id ?? routeClient;
    if (cid) return <ContactDrawer key={contact} contactId={contact} clientId={cid} onClose={closeParam('contact')} />;
  }

  const account = q.get('account');
  if (account === 'new') return <AccountDrawer key="new" accountId="new" onClose={closeParam('account')} />;
  if (account === 'edit' && routeClient) return <AccountDrawer key={routeClient} accountId={routeClient} onClose={closeParam('account')} />;
  return null;
}
