import { useNavigate } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { AccountPicker } from '../ui/AccountPicker';
import { Button } from '../ui/Button';
import { useApp } from '../../store/DataContext';
import { useUI } from '../../store/UIContext';
import { useNow } from '../../lib/hooks';
import { formatClock } from '../../lib/dates';
import { accountPath } from '../../lib/links';

export function TopBar() {
  const { accounts, settings, state } = useApp();
  const { openCapture, jumpRef } = useUI();
  const navigate = useNavigate();
  const now = useNow();
  return (
    <header className="topbar">
      <div className="topbar__jump">
        <AccountPicker
          jump
          size="sm"
          inputRef={jumpRef}
          accounts={accounts}
          value={null}
          onChange={(id) => id && navigate(accountPath(id))}
          placeholder="Jump to account…"
          aria-label="Jump to account"
        />
        <kbd className="topbar__kbd" aria-hidden="true">Ctrl+K</kbd>
      </div>
      <div className="topbar__spacer" />
      {state.runtime.source === 'mock' && (
        <span className="envtag envtag--mock" title="Showing in-memory mock data from db/mock_data.json. Nothing is saved.">Mock data</span>
      )}
      {state.runtime.mode === 'DEV' && <span className="envtag envtag--dev" title="DEV mode">DEV</span>}
      <time className="topbar__clock num" dateTime={now.toISOString()}>{formatClock(now, settings.time_display)}</time>
      <Button variant="primary" size="sm" icon={<Plus size={16} strokeWidth={1.5} />} onClick={() => openCapture()} aria-keyshortcuts="N">
        Capture
      </Button>
    </header>
  );
}
