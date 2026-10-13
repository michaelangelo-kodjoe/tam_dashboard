import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { AccountPicker, filterAccounts, type PickerAccount } from './AccountPicker';

const ACCTS: PickerAccount[] = [
  { id: '1', name: 'Zenith Capital', bpid: '1111111', status: 'Active' },
  { id: '2', name: 'Acme Partners', bpid: '2222222', status: 'Active' },
  { id: '3', name: 'Acme Legacy Fund', bpid: '3333333', status: 'Inactive' },
  { id: '4', name: 'Borealis', bpid: '4442222', status: 'Active' },
];

function Harness({ nullable, onChange }: { nullable?: boolean; onChange?: (v: string | null) => void }) {
  const [v, setV] = useState<string | null>(null);
  return <><AccountPicker aria-label="Account" accounts={ACCTS} value={v} onChange={(x) => { setV(x); onChange?.(x); }} nullable={nullable} /><button>after</button></>;
}
const input = () => screen.getByRole('combobox');
const active = () => document.getElementById(input().getAttribute('aria-activedescendant') ?? '')?.textContent;

describe('AccountPicker (editable combobox, guidelines §6.3)', () => {
  it('exposes combobox semantics and filters by name or BPID, case-insensitively', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    expect(input()).toHaveAttribute('aria-autocomplete', 'list');
    await user.type(input(), 'acme');
    expect(input()).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['Acme Partners2222222', 'Acme Legacy Fund3333333Inactive']);
    await user.clear(input());
    await user.type(input(), '2222');
    expect(screen.getAllByRole('option').map((o) => o.textContent?.slice(0, 6))).toEqual(['Acme P', 'Boreal']);
  });

  it('lists Inactive accounts last with an Inactive label', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(input());
    const names = screen.getAllByRole('option').map((o) => o.textContent ?? '');
    expect(names[names.length - 1]).toContain('Acme Legacy Fund');
    expect(names[names.length - 1]).toContain('Inactive');
    expect(filterAccounts(ACCTS, '').map((a) => a.id)).toEqual(['2', '4', '1', '3']);
  });

  it('shows "No accounts match" when nothing matches', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(input(), 'qqqq');
    expect(screen.getByText('No accounts match')).toBeInTheDocument();
    expect(screen.queryAllByRole('option')).toHaveLength(0);
  });

  it('bolds the matched substring', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.type(input(), 'eal');
    const strong = document.querySelector('.option strong');
    expect(strong?.textContent).toBe('eal');
  });

  it('Arrow keys move through options; Enter selects the active one and closes', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    input().focus();
    await user.keyboard('{ArrowDown}');
    expect(active()).toContain('Acme Partners');
    await user.keyboard('{ArrowDown}');
    expect(active()).toContain('Borealis');
    await user.keyboard('{ArrowUp}');
    await user.keyboard('{Enter}');
    expect(onChange).toHaveBeenCalledWith('2');
    expect(input()).toHaveAttribute('aria-expanded', 'false');
    expect(input()).toHaveValue('Acme Partners');
  });

  it('Enter with no active option does not select', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    await user.type(input(), 'acme{Enter}');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('Escape clears the typed text first, then closes on a second press', async () => {
    const user = userEvent.setup();
    const parentKey = vi.fn();
    render(<div onKeyDown={parentKey}><Harness /></div>);
    await user.type(input(), 'acme');
    parentKey.mockClear();
    await user.keyboard('{Escape}');
    expect(input()).toHaveValue('');
    expect(input()).toHaveAttribute('aria-expanded', 'true');
    await user.keyboard('{Escape}');
    expect(input()).toHaveAttribute('aria-expanded', 'false');
    expect(parentKey).not.toHaveBeenCalled(); // a parent dialog stays open
  });

  it('Tab accepts the active option only if one is active', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    await user.type(input(), 'bore');
    await user.keyboard('{Tab}');
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'after' })).toHaveFocus();
    input().focus();
    await user.clear(input());
    await user.type(input(), 'bore{ArrowDown}');
    await user.keyboard('{Tab}');
    expect(onChange).toHaveBeenCalledWith('4');
  });

  it('nullable: the top option is "No account" and selects null', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness nullable onChange={onChange} />);
    await user.click(input());
    const first = screen.getAllByRole('option')[0];
    expect(first).toHaveTextContent('No account');
    await user.click(first);
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it('clicking an option selects it', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    await user.click(input());
    await user.click(screen.getByRole('option', { name: /Zenith Capital/ }));
    expect(onChange).toHaveBeenCalledWith('1');
  });
});
