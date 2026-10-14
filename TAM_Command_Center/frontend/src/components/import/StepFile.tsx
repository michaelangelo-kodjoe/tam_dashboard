import { useRef, useState } from 'react';
import { Download, FileSpreadsheet, Upload } from 'lucide-react';
import { Button } from '../ui/Button';
import { cx } from '../../lib/cx';
import type { ImportFormat, ImportPlan } from '../../types';

function sizeLabel(n: number): string {
  return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}
export function readDescription(f: ImportPlan['file']): string {
  const rows = `${f.rows_found} ${f.rows_found === 1 ? 'row' : 'rows'}`;
  if (f.format === 'xlsx') return `${rows} read from sheet "${f.sheet ?? 'Accounts'}"`;
  return `${rows} read as CSV (${f.encoding ?? 'UTF-8'}, ${f.delimiter ?? 'comma'} separated)`;
}

interface Props {
  plan: ImportPlan | null;
  busy: boolean;
  error: string | null;
  onFile: (f: File) => void;
  onRemove: () => void;
  onTemplate: (f: ImportFormat) => void;
  templateBusy: ImportFormat | null;
}

export function StepFile({ plan, busy, error, onFile, onRemove, onTemplate, templateBusy }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const pick = () => input.current?.click();
  return (
    <div className="imp-file">
      <div>
        {plan ? (
          <div className="imp-card" role="group" aria-label="Chosen file">
            <FileSpreadsheet size={20} strokeWidth={1.5} aria-hidden="true" className="muted" />
            <div className="imp-card__text">
              <b className="truncate" title={plan.file.name}>{plan.file.name}</b>
              <span className="muted sm">{readDescription(plan.file)} · {sizeLabel(plan.file.size_bytes)}</span>
            </div>
            <Button size="sm" onClick={pick} disabled={busy}>Choose another file</Button>
            <Button size="sm" variant="ghost" onClick={onRemove} disabled={busy}>Remove</Button>
          </div>
        ) : (
          <div
            className={cx('imp-drop', over && 'is-over')}
            role="group"
            aria-label="File drop area"
            onDragOver={(e) => { e.preventDefault(); setOver(true); }}
            onDragLeave={() => setOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setOver(false);
              const f = e.dataTransfer.files?.[0];
              if (f) onFile(f);
            }}
          >
            <Upload size={20} strokeWidth={1.5} aria-hidden="true" />
            <p className="imp-drop__title">Drop an .xlsx or .csv file here</p>
            <p className="muted">
              or <button type="button" className="imp-link" data-autofocus onClick={pick} disabled={busy}>choose a file</button>. Only .xlsx and .csv, up to 500 account rows and 5 MB.
            </p>
          </div>
        )}
        <input
          ref={input}
          type="file"
          className="sr-only"
          tabIndex={-1}
          aria-hidden="true"
          accept=".xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) onFile(f);
          }}
        />
        <p role="status" className="muted imp-note">{busy ? 'Reading the file…' : 'Nothing is written to the database until you review the preview and click Apply.'}</p>
        {error && <p role="alert" className="imp-error">{error}</p>}
      </div>
      <div className="imp-side">
        <div>
          <h3 className="label">Template</h3>
          <p className="muted">Start from the template so the column names and the Status list match.</p>
          <div className="imp-btnrow">
            <Button icon={<Download size={16} strokeWidth={1.5} />} onClick={() => onTemplate('xlsx')} busy={templateBusy === 'xlsx'} busyLabel="Preparing…">Download .xlsx template</Button>
            <Button icon={<Download size={16} strokeWidth={1.5} />} onClick={() => onTemplate('csv')} busy={templateBusy === 'csv'} busyLabel="Preparing…">Download .csv template</Button>
          </div>
        </div>
        <div>
          <h3 className="label">What the file may contain</h3>
          <ul className="imp-rules">
            <li><b>Account name</b> is required. BPID, Products, Status, Next contact date and Notes are optional.</li>
            <li>Contacts and servers are not imported here.</li>
            <li>Names similar to an existing account, or to another row, are listed for you to confirm one by one.</li>
            <li>Existing accounts are only filled where a field is blank; nothing is overwritten.</li>
            <li>In a .csv file, text starting with = + - or @ is kept as plain text and never calculated.</li>
          </ul>
        </div>
      </div>
    </div>
  );
}
