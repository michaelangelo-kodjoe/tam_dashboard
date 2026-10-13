import { Link } from 'react-router-dom';
import { EmptyState } from '../components/ui/Feedback';
import { PageHeader } from '../components/ui/Panel';
import { useDocumentTitle } from '../lib/hooks';

export function NotFoundPage() {
  useDocumentTitle('Not found');
  return (
    <div className="page">
      <PageHeader title="Page not found" />
      <EmptyState action={<Link to="/today">Go to Today</Link>}>There is nothing at this address.</EmptyState>
    </div>
  );
}
