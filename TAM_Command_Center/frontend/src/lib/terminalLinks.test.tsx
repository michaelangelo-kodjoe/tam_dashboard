// Bloomberg Terminal links: parser, component, edit fields, clickable rows, saved task notes on Today and Tasks.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { newMock } from '../data/mock/testFile';
import { TerminalLinkText } from '../components/ui/TerminalLinkText';
import { parseTerminalText } from './terminalLinks';

const links = (s: string) => parseTerminalText(s).filter((p) => p.type === 'terminal');
afterEach(() => cleanup());

describe('parser', () => {
  it('{BAMS <GO>} -> bbg://screens/BAMS, label keeps braces and <GO>', () => {
    expect(parseTerminalText('{BAMS <GO>}')).toEqual([{ type: 'terminal', label: '{BAMS <GO>}', command: 'BAMS', href: 'bbg://screens/BAMS' }]);
  });
  it('encodes spaces and slashes', () => {
    expect(links('{DRQS 12345 <GO>}')[0]).toMatchObject({ href: 'bbg://screens/DRQS%2012345' });
    expect(links('{NMS R 160069 <GO>}')[0]).toMatchObject({ href: 'bbg://screens/NMS%20R%20160069' });
    expect(links('{IBM US Equity DES}')[0]).toMatchObject({ href: 'bbg://screens/IBM%20US%20Equity%20DES' });
    expect(links('{BLST /ID 7256714320267182081 <GO>}')[0]).toMatchObject({ command: 'BLST /ID 7256714320267182081' });
  });
  it('works without <GO> and trims whitespace but keeps the user label', () => {
    expect(links('{BAMS}')[0]).toMatchObject({ href: 'bbg://screens/BAMS' });
    expect(links('{   BAMS <GO>   }')[0]).toMatchObject({ label: '{   BAMS <GO>   }', href: 'bbg://screens/BAMS' });
  });
  it('several commands in one string, surrounding text preserved', () => {
    const parts = parseTerminalText('Use {BAMS <GO>}, {NMS <GO>} and {DRQS 12345 <GO>}.');
    expect(parts.filter((p) => p.type === 'terminal')).toHaveLength(3);
    expect(parts.filter((p) => p.type === 'text').map((p) => (p as { value: string }).value).join('')).toBe('Use ,  and .');
    expect(parts.map((p) => (p.type === 'text' ? p.value : p.label)).join('')).toBe('Use {BAMS <GO>}, {NMS <GO>} and {DRQS 12345 <GO>}.');
  });
  it('unmatched and empty braces stay text', () => {
    for (const s of ['Check {BAMS', 'Check BAMS}', '{}', '{ }', '{ <GO> }', 'a } b { c']) expect(links(s)).toHaveLength(0);
    expect(parseTerminalText('{}')).toEqual([{ type: 'text', value: '{}' }]);
  });
  it('every generated link uses only bbg://screens/ (no other protocol can come from text)', () => {
    for (const s of ['{javascript:alert(1)}', '{http://evil.test}', '{<img src=x onerror=1>}']) for (const l of links(s)) expect((l as { href: string }).href.startsWith('bbg://screens/')).toBe(true);
  });
});

describe('component', () => {
  it('renders real anchors with an accessible name and visible label; text stays text', () => {
    render(<p>Review <TerminalLinkText text="Review {BAMS <GO>} then {DRQS 1 <GO>}" /></p>);
    const a = screen.getByRole('link', { name: 'Open {BAMS <GO>} in Bloomberg Terminal' });
    expect(a).toHaveAttribute('href', 'bbg://screens/BAMS');
    expect(a).toHaveTextContent('{BAMS <GO>}');
    expect(a).toHaveClass('tlink');
    expect(screen.getAllByRole('link')).toHaveLength(2);
  });
  it('does not turn markup into HTML', () => {
    const { container } = render(<div><TerminalLinkText text="<b>x</b> {BAMS}" /></div>);
    expect(container.querySelector('b')).toBeNull();
    expect(container.textContent).toContain('<b>x</b>');
  });
  it('raw edit fields are not converted', () => {
    render(<div><textarea aria-label="Notes" defaultValue="Check {BAMS <GO>}" /><input aria-label="Task" defaultValue="{DRQS 1 <GO>}" /></div>);
    expect(screen.getByLabelText('Notes')).toHaveValue('Check {BAMS <GO>}');
    expect(screen.queryByRole('link')).toBeNull();
  });
  it('a click on the link inside a clickable row does not trigger the row, and is not prevented', () => {
    const row = vi.fn();
    render(<div role="button" tabIndex={0} onClick={row} onKeyDown={row}><TerminalLinkText text="{BAMS <GO>}" /></div>);
    const a = screen.getByRole('link');
    const notCancelled = fireEvent.click(a);
    fireEvent.keyDown(a, { key: 'Enter' });
    expect(row).not.toHaveBeenCalled();
    expect(notCancelled).toBe(true);
  });
  it('source never uses dangerouslySetInnerHTML', () => {
    for (const f of ['components/ui/TerminalLinkText.tsx', 'components/ui/Feedback.tsx', 'lib/terminalLinks.ts']) {
      expect(readFileSync(resolve(__dirname, '..', f), 'utf8')).not.toMatch(/dangerouslySetInnerHTML/);
    }
  });
});

describe('where notes are shown', () => {
  const NOTE = '{DRQS 185973571 <GO>}  They are still discussing a better way to roll this out';
  async function bootWithNote(path: string) {
    const ds = newMock();
    const queue = (await ds.getToday()).queue;
    const item = queue.find((q) => q.kind === 'task')!;
    const task = (await ds.getTasks({})).find((t) => t.id === item.id)!;
    await ds.saveTask({ ...task, notes: NOTE, expected_row_version: task.row_version });
    window.history.pushState({}, '', path.replace('{id}', task.id));
    const user = userEvent.setup();
    render(<App ds={ds} />);
    await screen.findByRole('navigation', { name: 'Primary' });
    return { user, ds, task, item };
  }

  it('Today: the selected task shows its notes with a working link; the row preview is clickable without selecting', async () => {
    const { user, item } = await bootWithNote('/today');
    const row = (await screen.findAllByRole('option')).find((o) => o.textContent?.includes(item.title))!;
    await user.click(row);
    const detail = await screen.findByRole('region', { name: 'Selected item' });
    expect(within(detail).getByText('Notes')).toBeInTheDocument();
    expect(within(detail).getByRole('link', { name: /DRQS 185973571/ })).toHaveAttribute('href', 'bbg://screens/DRQS%20185973571');
    expect(within(detail).getByText(/still discussing a better way/)).toBeInTheDocument();
    const preview = within(row).getByRole('link', { name: /DRQS 185973571/ });
    expect(row.getAttribute('aria-selected')).toBe('true');
    const other = (await screen.findAllByRole('option')).find((o) => o !== row)!;
    await user.click(other);
    expect(row.getAttribute('aria-selected')).toBe('false');
    fireEvent.click(preview);
    expect(row.getAttribute('aria-selected')).toBe('false'); // link click did not select the row
  });

  it('a saved task note renders the link after reload on the Tasks list; the popup shows it as a link and the edit drawer keeps the raw text', async () => {
    const { ds, task } = await bootWithNote('/tasks');
    expect((await screen.findAllByRole('link', { name: /DRQS 185973571/ })).length).toBeGreaterThan(0);
    cleanup(); // reload: same stored data, fresh UI
    window.history.pushState({}, '', `/tasks?task=${task.id}`);
    render(<App ds={ds} />);
    const view = await screen.findByRole('dialog');
    expect(within(view).getByRole('link', { name: /DRQS 185973571/ })).toHaveAttribute('href', 'bbg://screens/DRQS%20185973571');
  }, 40000);

  it('the edit drawer keeps the raw note text (no links while editing)', async () => {
    const { ds, task } = await bootWithNote('/tasks?task={id}&edit=1');
    void ds;
    cleanup();
    window.history.pushState({}, '', `/tasks?task=${task.id}&edit=1`);
    render(<App ds={ds} />);
    const notes = await screen.findByLabelText('Notes');
    expect(notes).toHaveValue(NOTE);
    expect(within(screen.getByRole('dialog')).queryByRole('link', { name: /DRQS/ })).toBeNull();
  }, 40000);
});
