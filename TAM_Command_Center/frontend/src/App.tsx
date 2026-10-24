import { useMemo } from 'react';
import { BrowserRouter } from 'react-router-dom';
import { AppShell } from './components/shell/AppShell';
import { ToastProvider } from './components/ui/Toast';
import { DataProvider } from './store/DataContext';
import { UIProvider } from './store/UIContext';
import { createDataSource } from './data';
import type { DataSource } from './data/DataSource';

export function App({ ds: injected }: { ds?: DataSource }) {
  const ds = useMemo(() => injected ?? createDataSource(), [injected]);
  return (
    <BrowserRouter>
      <DataProvider ds={ds}>
        <ToastProvider>
          <UIProvider>
            <AppShell />
          </UIProvider>
        </ToastProvider>
      </DataProvider>
    </BrowserRouter>
  );
}
