import { useEffect, useState } from 'react';
import { Navigate, Route, Routes, useLocation, useMatch } from 'react-router-dom';
import { NavRail } from './NavRail';
import { TopBar } from './TopBar';
import { EditorHost } from '../editors/EditorHost';
import { QuickCaptureDialog } from '../editors/QuickCaptureDialog';
import { ErrorBanner, SkeletonRows } from '../ui/Feedback';
import { AppStateProvider, useApp, useQuery } from '../../store/DataContext';
import { useUI } from '../../store/UIContext';
import { TodayPage } from '../../pages/TodayPage';
import { AccountsPage } from '../../pages/AccountsPage';
import { WorkspacePage } from '../../pages/WorkspacePage';
import { TasksPage } from '../../pages/TasksPage';
import { SettingsPage } from '../../pages/SettingsPage';
import { PlaceholderPage } from '../../pages/PlaceholderPage';
import { SandboxPage } from '../../pages/SandboxPage';
import { NotFoundPage } from '../../pages/NotFoundPage';

function isEditable(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable || el.getAttribute('role') === 'combobox' || el.getAttribute('role') === 'textbox';
}

function Shell() {
  const { settings } = useApp();
  const { openCapture, focusJump } = useUI();
  const loc = useLocation();
  const accountMatch = useMatch('/accounts/:clientId/*');

  // Global shortcuts: Ctrl+K jumps to an account; N opens Quick Capture (never inside fields).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        focusJump();
        return;
      }
      if (e.key.toLowerCase() === 'n' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && !e.repeat) {
        if (isEditable(e.target) || document.body.style.overflow === 'hidden') return;
        e.preventDefault();
        openCapture({ clientId: accountMatch?.params.clientId ?? null });
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [openCapture, focusJump, accountMatch?.params.clientId]);

  return (
    <div className="app">
      <a href="#main" className="skip-link">Skip to main content</a>
      <NavRail />
      <div className="app__col">
        <TopBar />
        <main id="main" tabIndex={-1} className="app__main" key={loc.pathname.split('/').slice(0, 3).join('/')}>
          <Routes>
            <Route path="/" element={<Navigate to={`/${settings.default_landing}`} replace />} />
            <Route path="/today" element={<TodayPage />} />
            <Route path="/accounts" element={<AccountsPage />} />
            <Route path="/accounts/:clientId" element={<WorkspacePage />} />
            <Route path="/accounts/:clientId/:tab" element={<WorkspacePage />} />
            <Route path="/tasks" element={<TasksPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/operations" element={<PlaceholderPage kind="operations" />} />
            <Route path="/bams" element={<PlaceholderPage kind="bams" />} />
            <Route path="/bridge" element={<PlaceholderPage kind="bridge" />} />
            <Route path="/sandbox" element={<SandboxPage />} />
            <Route path="*" element={<NotFoundPage />} />
          </Routes>
        </main>
      </div>
      <EditorHost />
      <QuickCaptureDialog />
    </div>
  );
}

export function AppShell() {
  const [refreshMs, setRefreshMs] = useState<number | null>(null);
  const q = useQuery('app-state', (ds) => ds.getState(), { refreshMs });
  const minutes = q.data?.settings.auto_refresh_minutes;
  useEffect(() => {
    setRefreshMs(minutes && minutes !== 'off' ? Number(minutes) * 60_000 : null);
  }, [minutes]);

  if (!q.data) {
    return (
      <div className="app app--boot">
        <div className="app__boot">
          <h1 className="pagehead__title">TAM Command Center</h1>
          {q.error ? <ErrorBanner error={q.error} onRetry={q.reload} title="Could not start the app" /> : <SkeletonRows rows={6} label="Loading data" />}
        </div>
      </div>
    );
  }
  return (
    <AppStateProvider state={q.data} stale={q.stale} lastOk={q.lastOk} reload={q.reload}>
      <Shell />
    </AppStateProvider>
  );
}
