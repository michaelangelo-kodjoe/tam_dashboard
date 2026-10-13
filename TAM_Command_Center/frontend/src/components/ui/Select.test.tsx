import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Select, stepIndex, type SelectOption } from './Select';

const OPTS: SelectOption[] = [
  { value: 'a', label: 'Alpha' },
  { value: 'b', label: 'Bravo' },
  { value: 'c', label: 'Charlie', disabled: true },
  { value: 'd', label: 'Delta' },
  { value: 'e', label: 'Echo' },
];
const MANY: SelectOption[] = Array.from({ length: 25 }, (_, i) => ({ value: `v${i}`, label: `Item ${String(i).padStart(2, '0')}` }));

function Harness({ initial = null, options = OPTS, onChange, clearable }: { initial?: string | null; options?: SelectOption[]; onChange?: (v: string | null) => void; clearable?: boolean }) {
  const [v, setV] = useState<string | null>(initial);
  return (
    <>
      <span id="lbl">Pick</span>
      <Select labelledBy="lbl" value={v} onChange={(n) => { setV(n); onChange?.(n); }} options={options} name="pick" clearable={clearable} />
      <button>after</button>
    </>
  );
}
const combo = () => screen.getByRole('combobox');
const active = () => document.getElementById(combo().getAttribute('aria-activedescendant') ?? '')?.textContent;

describe('Select (select-only combobox, guidelines §6.1)', () => {
  it('has combobox/listbox semantics, a hidden mirror input and aria-selected on the chosen option', async () => {
    const user = userEvent.setup();
    const { container } = render(<Harness initial="b" />);
    expect(combo()).toHaveAttribute('aria-haspopup', 'listbox');
    expect(combo()).toHaveAttribute('aria-expanded', 'false');
    expect(combo()).toHaveAttribute('aria-labelledby', 'lbl');
    expect(container.querySelector('input[type=hidden][name=pick]')).toHaveValue('b');
    await user.click(combo());
    expect(combo()).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Bravo' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('option', { name: 'Alpha' })).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByRole('option', { name: 'Charlie' })).toHaveAttribute('aria-disabled', 'true');
    expect(active()).toBe('Bravo');
  });

  it('closed: ArrowDown/ArrowUp open with the selected (or first) option active', async () => {
    const user = userEvent.setup();
    render(<Harness initial="d" />);
    combo().focus();
    await user.keyboard('{ArrowDown}');
    expect(active()).toBe('Delta');
    await user.keyboard('{Escape}');
    await user.keyboard('{ArrowUp}');
    expect(active()).toBe('Delta');
  });

  it('closed with no value: ArrowDown opens on the first option', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    combo().focus();
    await user.keyboard('{ArrowDown}');
    expect(active()).toBe('Alpha');
  });

  it('closed: Alt+ArrowDown opens without moving', async () => {
    const user = userEvent.setup();
    render(<Harness initial="e" />);
    combo().focus();
    await user.keyboard('{Alt>}{ArrowDown}{/Alt}');
    expect(combo()).toHaveAttribute('aria-expanded', 'true');
    expect(active()).toBe('Echo');
  });

  it('closed: Home/End open with the first/last option active', async () => {
    const user = userEvent.setup();
    render(<Harness initial="b" />);
    combo().focus();
    await user.keyboard('{End}');
    expect(active()).toBe('Echo');
    await user.keyboard('{Escape}{Home}');
    expect(active()).toBe('Alpha');
  });

  it('closed: Enter and Space open the list', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    combo().focus();
    await user.keyboard('{Enter}');
    expect(combo()).toHaveAttribute('aria-expanded', 'true');
    await user.keyboard('{Escape}');
    await user.keyboard(' ');
    expect(combo()).toHaveAttribute('aria-expanded', 'true');
  });

  it('open: arrows move the active option, skip disabled options, and do not wrap', async () => {
    const user = userEvent.setup();
    render(<Harness initial="a" />);
    combo().focus();
    await user.keyboard('{ArrowDown}');
    expect(active()).toBe('Alpha');
    await user.keyboard('{ArrowDown}');
    expect(active()).toBe('Bravo');
    await user.keyboard('{ArrowDown}'); // Charlie is disabled
    expect(active()).toBe('Delta');
    await user.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}');
    expect(active()).toBe('Echo'); // no wrap
    await user.keyboard('{ArrowUp}{ArrowUp}{ArrowUp}{ArrowUp}{ArrowUp}');
    expect(active()).toBe('Alpha'); // no wrap at the top
  });

  it('open: Home/End and PageUp/PageDown (10 options)', async () => {
    const user = userEvent.setup();
    render(<Harness options={MANY} initial="v0" />);
    combo().focus();
    await user.keyboard('{ArrowDown}');
    await user.keyboard('{PageDown}');
    expect(active()).toBe('Item 10');
    await user.keyboard('{PageDown}{PageDown}');
    expect(active()).toBe('Item 24');
    await user.keyboard('{PageUp}');
    expect(active()).toBe('Item 14');
    await user.keyboard('{Home}');
    expect(active()).toBe('Item 00');
    await user.keyboard('{End}');
    expect(active()).toBe('Item 24');
  });

  it('open: Enter selects the active option, closes, and focus stays on the trigger', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness initial="a" onChange={onChange} />);
    combo().focus();
    await user.keyboard('{ArrowDown}{ArrowDown}{Enter}');
    expect(onChange).toHaveBeenCalledWith('b');
    expect(combo()).toHaveAttribute('aria-expanded', 'false');
    expect(combo()).toHaveFocus();
    expect(combo()).toHaveTextContent('Bravo');
  });

  it('open: Space selects the active option and closes', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness initial="a" onChange={onChange} />);
    combo().focus();
    await user.keyboard('{ArrowDown}{ArrowDown} ');
    expect(onChange).toHaveBeenCalledWith('b');
    expect(combo()).toHaveAttribute('aria-expanded', 'false');
  });

  it('open: Alt+ArrowUp selects the active option and closes', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness initial="a" onChange={onChange} />);
    combo().focus();
    await user.keyboard('{ArrowDown}{ArrowDown}');
    await user.keyboard('{Alt>}{ArrowUp}{/Alt}');
    expect(onChange).toHaveBeenCalledWith('b');
    expect(combo()).toHaveAttribute('aria-expanded', 'false');
  });

  it('open: Escape closes without changing the value, focus stays, and does NOT reach a parent handler', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const parentKey = vi.fn();
    render(<div onKeyDown={parentKey}><Harness initial="a" onChange={onChange} /></div>);
    combo().focus();
    await user.keyboard('{ArrowDown}{ArrowDown}');
    parentKey.mockClear();
    await user.keyboard('{Escape}');
    expect(onChange).not.toHaveBeenCalled();
    expect(combo()).toHaveAttribute('aria-expanded', 'false');
    expect(combo()).toHaveFocus();
    expect(combo()).toHaveTextContent('Alpha');
    expect(parentKey).not.toHaveBeenCalled();
  });

  it('closed: Escape is not consumed, so an enclosing dialog can close (documented deviation)', async () => {
    const user = userEvent.setup();
    const parentKey = vi.fn();
    render(<div onKeyDown={parentKey}><Harness initial="a" /></div>);
    combo().focus();
    await user.keyboard('{Escape}');
    expect(parentKey).toHaveBeenCalled();
  });

  it('open: Tab selects the active option, closes, and moves focus on', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness initial="a" onChange={onChange} />);
    combo().focus();
    await user.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}');
    await user.keyboard('{Tab}');
    expect(onChange).toHaveBeenCalledWith('d');
    expect(combo()).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByRole('button', { name: 'after' })).toHaveFocus();
  });

  it('open: Shift+Tab selects and closes too', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<><button>before</button><Harness initial="a" onChange={onChange} /></>);
    combo().focus();
    await user.keyboard('{ArrowDown}{ArrowDown}');
    await user.keyboard('{Shift>}{Tab}{/Shift}');
    expect(onChange).toHaveBeenCalledWith('b');
    expect(screen.getByRole('button', { name: 'before' })).toHaveFocus();
  });

  it('type-ahead: printable characters jump to the first match (closed: opens; open: moves)', async () => {
    const user = userEvent.setup();
    render(<Harness initial="a" />);
    combo().focus();
    await user.keyboard('d');
    expect(combo()).toHaveAttribute('aria-expanded', 'true');
    expect(active()).toBe('Delta');
    await user.keyboard('{Escape}');
    await user.keyboard('{ArrowDown}');
    await new Promise((r) => setTimeout(r, 520)); // type-ahead buffer is 500ms
    await user.keyboard('e');
    expect(active()).toBe('Echo');
  });

  it('mouse: clicking the trigger toggles, clicking an option selects, clicking outside closes without change', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness initial="a" onChange={onChange} />);
    await user.click(combo());
    expect(combo()).toHaveAttribute('aria-expanded', 'true');
    await user.click(combo());
    expect(combo()).toHaveAttribute('aria-expanded', 'false');
    await user.click(combo());
    await user.click(screen.getByRole('option', { name: 'Delta' }));
    expect(onChange).toHaveBeenCalledWith('d');
    expect(combo()).toHaveAttribute('aria-expanded', 'false');
    await user.click(combo());
    onChange.mockClear();
    await user.click(document.body);
    expect(combo()).toHaveAttribute('aria-expanded', 'false');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('a disabled option cannot be chosen by click', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness initial="a" onChange={onChange} />);
    await user.click(combo());
    await user.click(screen.getByRole('option', { name: 'Charlie' }));
    expect(onChange).not.toHaveBeenCalled();
    expect(combo()).toHaveAttribute('aria-expanded', 'true');
  });

  it('clearable: the "None" option is first and clears to null', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness initial="b" onChange={onChange} clearable />);
    await user.click(combo());
    const opts = screen.getAllByRole('option');
    expect(opts[0]).toHaveTextContent('None');
    await user.click(opts[0]);
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it('stepIndex skips disabled options and never wraps', () => {
    const o = [{}, { disabled: true }, {}];
    expect(stepIndex(o, 0, 1)).toBe(2);
    expect(stepIndex(o, 2, 1)).toBe(2);
    expect(stepIndex(o, 0, -1)).toBe(0);
  });
});
