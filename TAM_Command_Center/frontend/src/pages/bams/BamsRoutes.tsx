import { Route, Routes } from 'react-router-dom';
import { DashboardPage } from './DashboardPage';
import { AlertsPage } from './AlertsPage';
import { ConfigPage } from './ConfigPage';
import { BamsSettingsPage } from './BamsSettingsPage';
import { ImportPage } from './ImportPage';
import { NotFoundPage } from '../NotFoundPage';

export function BamsRoutes() {
  return (
    <Routes>
      <Route index element={<DashboardPage />} />
      <Route path="alerts" element={<AlertsPage />} />
      <Route path="config" element={<ConfigPage />} />
      <Route path="settings" element={<BamsSettingsPage />} />
      <Route path="import" element={<ImportPage />} />
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}
