// Inline similar-account confirmation inside the Add account form (D-45, mockup 06 as amended by D-42/D-48).
import { useEffect, useRef } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Button } from '../ui/Button';
import { Facts, Reasons, StrengthBadge, RadioList } from '../import/ImportParts';
import type { ExactMatch, SimilarCandidate } from '../../types';

export type SimilarChoice = 'same' | 'different';

interface Props {
  typedName: string;
  exact: ExactMatch | null;
  candidates: SimilarCandidate[];
  /** which existing account "Same account" opens when several were found */
  target: string | null;
  onTarget: (id: string) => void;
  onSame: (id: string) => void;
  onDifferent: () => void;
  onCancel: () => void;
  busy?: boolean;
  /** move focus into the panel (on submit); not on blur */
  focusOnShow?: boolean;
}

export function SimilarAccountPanel({ typedName, exact, candidates, target, onTarget, onSame, onDifferent, onCancel, busy, focusOnShow }: Props) {
  const head = useRef<HTMLHeadingElement>(null);
  useEffect(() => { if (focusOnShow) head.current?.focus(); }, [focusOnShow]);
  const accounts = candidates.filter((c) => c.ref.type === 'account');
  const multi = accounts.length > 1;
  const chosen = exact ? exact.id : multi ? target : (accounts[0]?.ref.type === 'account' ? accounts[0].ref.id : null);
  const name = exact ? exact.name : accounts[0]?.name;
  return (
    <section className="imp-similar" aria-labelledby="similar-title" role="region">
      <div className="imp-similar__head">
        <AlertTriangle size={16} strokeWidth={1.5} aria-hidden="true" className="warning-text" />
        <h3 id="similar-title" ref={head} tabIndex={-1} className="imp-similar__title">
          {exact ? `An account named ${exact.name} already exists.` : multi ? 'Similar accounts found.' : `Similar account found: ${name}.`}
          {' '}<span className="muted">{exact ? 'Open it instead.' : 'Is this the same account?'}</span>
        </h3>
      </div>
      {exact && (
        <p className="muted sm">An account with this name already exists ({exact.status}); a second account of that name cannot be created. <span className="sr-only">You typed {typedName}.</span></p>
      )}
      {!exact && accounts.map((c) => (
        <div key={c.ref.type === 'account' ? c.ref.id : ''} className="imp-cand">
          <div className="label">{multi ? 'Possible match' : 'Existing account'}</div>
          <div className="imp-cand__head"><b>{c.name}</b><StrengthBadge strength={c.strength} /></div>
          <Facts c={c} />
          <Reasons reasons={c.reasons} differences={c.differences} />
        </div>
      ))}
      {!exact && multi && (
        <div className="imp-target">
          <div className="label">Same as which account?</div>
          <RadioList label="Which existing account is this" value={target} onChange={onTarget} options={accounts.map((c) => ({ value: c.ref.type === 'account' ? c.ref.id : '', label: c.name, sub: `${c.strength} match` }))} />
        </div>
      )}
      <div className="imp-btnrow">
        <Button variant="secondary" onClick={() => chosen && onSame(chosen)} disabled={!chosen || busy}>Same account</Button>
        {!exact && <Button variant="secondary" onClick={onDifferent} busy={busy} busyLabel="Creating…">Different account</Button>}
        <Button variant="ghost" onClick={onCancel} disabled={busy}>Cancel</Button>
      </div>
      <p className="muted sm">
        {exact
          ? `Same account opens the existing ${exact.name} and adds nothing. Cancel returns to the form.`
          : `Same account opens the existing ${name ?? 'account'} and adds nothing. Different account creates ${typedName} as a new account. Cancel returns to the form.`}
      </p>
    </section>
  );
}
