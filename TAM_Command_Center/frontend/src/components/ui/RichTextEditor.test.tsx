import { readFileSync } from 'node:fs';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RichTextEditor } from './RichTextEditor';
import { NoteBody } from './NoteBody';
import { PALETTE, sanitizeHtml } from '../../lib/richText';
import type { Note } from '../../types';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const mkNote = (body: string): Note => ({ id: 'n', client_id: 'c', note_type: 'Call Note', timestamp: '2026-10-14T10:00:00Z', subject: null, body, body_format: 'html', body_text: 'x', action_items: null, source: 'GUI', created_at: '', updated_at: '', row_version: 1 });

describe('lists are visible (bug fix)', () => {
  it('the stylesheet restores markers, indentation and nesting for the editor and for rendered notes', () => {
    const css = readFileSync('src/styles/ui.css', 'utf8');
    for (const root of ['.rte-body', '.rendered']) {
      expect(css).toMatch(new RegExp(`\\${root} ul[^{]*\\{[^}]*list-style: disc outside`));
      expect(css).toMatch(new RegExp(`\\${root} ol[^{]*\\{[^}]*list-style: decimal outside`));
      expect(css).toMatch(new RegExp(`\\${root} ul ul[^{]*\\{[^}]*circle`));
    }
    expect(css).toMatch(/\.rendered ul, \.rendered ol \{[^}]*padding-left: 24px/);
  });
  it('rendered notes keep nested lists as real ul/ol/li elements', () => {
    const { container } = render(<NoteBody note={mkNote('<ul><li>a<ul><li>b</li></ul></li></ul><ol><li>c</li></ol>')} expanded long={false} />);
    expect(container.querySelectorAll('ul ul li')).toHaveLength(1);
    expect(container.querySelector('ol li')?.textContent).toBe('c');
  });
});

describe('palette colours render as styled spans without innerHTML', () => {
  it('shows palette colours and drops others', () => {
    const { container } = render(<NoteBody note={mkNote('<p><span style="color:#E5484D">red</span> <span style="color:#123456">odd</span></p>')} expanded long={false} />);
    const spans = container.querySelectorAll('span');
    expect((spans[0] as HTMLElement).style.color).toBe('rgb(229, 72, 77)');
    expect(spans.length).toBe(1);
    expect(container.textContent).toContain('odd');
  });
});

describe('RichTextEditor toolbar (QA-W1-1)', () => {
  it('is not remounted by re-renders and keeps keyboard focus on the button; Enter and Space activate', async () => {
    const user = userEvent.setup();
    const exec = vi.fn((..._a: unknown[]) => true);
    (document as unknown as { execCommand: unknown }).execCommand = exec;
    render(<RichTextEditor initialHtml="<p>hello</p>" onChange={() => undefined} />);
    const bold = screen.getByRole('button', { name: /^Bold/ });
    bold.focus();
    fireEvent(document, new Event('selectionchange')); // state updates used to remount the toolbar
    expect(screen.getByRole('button', { name: /^Bold/ })).toBe(bold);
    await user.keyboard('{Enter}');
    expect(exec).toHaveBeenCalledWith('bold', false, undefined);
    expect(document.activeElement).toBe(bold);
    await user.keyboard(' ');
    expect(exec.mock.calls.filter((c) => c[0] === 'bold')).toHaveLength(2);
    expect(document.activeElement).toBe(bold);
    await user.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /^Italic/ }));
    await user.keyboard('{End}');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Clear formatting' }));
    delete (document as unknown as { execCommand?: unknown }).execCommand;
  });
  it('reports edits and the empty state', () => {
    const seen: string[] = [];
    render(<RichTextEditor initialHtml="" onChange={(h) => seen.push(h)} />);
    const body = screen.getByRole('textbox', { name: 'Body' });
    body.innerHTML = '<p>x</p>'; fireEvent.input(body);
    body.innerHTML = '<p><br></p>'; fireEvent.input(body);
    expect(seen).toEqual(['<p>x</p>', '']);
  });
  it('reports palette colours in the hex form the server accepts (browsers store rgb)', () => {
    const seen: string[] = [];
    render(<RichTextEditor initialHtml="" onChange={(h) => seen.push(h)} />);
    const body = screen.getByRole('textbox', { name: 'Body' });
    body.innerHTML = '<span style="color: rgb(229, 72, 77);">hi</span>'; fireEvent.input(body);
    body.innerHTML = '<span style="font-size: 16px; color: rgb(250, 154, 40);">a</span><span style="color: rgb(1, 2, 3);">b</span>'; fireEvent.input(body);
    expect(seen).toEqual(['<span style="color:#E5484D">hi</span>', '<span style="font-size: 16px; color:#FA9A28">a</span>b']);
  });
});

describe('text colour palette', () => {
  it('opens from the toolbar, has every named swatch plus Default, is keyboard operable and applies via foreColor', async () => {
    const user = userEvent.setup();
    const exec = vi.fn((..._a: unknown[]) => true);
    (document as unknown as { execCommand: unknown }).execCommand = exec;
    render(<RichTextEditor initialHtml="<p>hello</p>" onChange={() => undefined} />);
    const trigger = screen.getByRole('button', { name: /^Text colour/ });
    expect(trigger).toHaveAccessibleName('Text colour: Default');
    expect(trigger.querySelector('.rte-a-bar')).toHaveAttribute('data-colour', 'default');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    trigger.focus();
    await user.keyboard('{Enter}');
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    const group = screen.getByRole('group', { name: 'Text colour' });
    for (const p of PALETTE) expect(group.querySelector(`button[aria-label="${p.name}"]`)).toHaveAttribute('title', p.name);
    expect(group.querySelector('button[aria-label="Default"]')).toBeTruthy();
    await vi.waitFor(() => expect(document.activeElement).toBe(group.querySelector('button')));
    await user.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(group.querySelector('button[aria-label="Red"]'));
    await user.keyboard('{Enter}');
    expect(screen.getByRole('button', { name: 'Text colour: Red' })).toBeInTheDocument(); // bare caret: pending colour, no recolouring command
    expect(exec).not.toHaveBeenCalledWith('foreColor', expect.anything(), expect.anything());
    expect(screen.queryByRole('group', { name: 'Text colour' })).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(trigger).toHaveAccessibleName('Text colour: Red'); // Word-style A with the current colour underneath
    expect(trigger.querySelector('.rte-a-bar')).toHaveAttribute('data-colour', '#E5484D');
    await user.keyboard('{Enter}{Escape}');
    expect(screen.queryByRole('group', { name: 'Text colour' })).toBeNull();
    expect(document.activeElement).toBe(trigger);
    delete (document as unknown as { execCommand?: unknown }).execCommand;
  });
});

describe('pending colour at a bare caret (Word behaviour)', () => {
  function setup(html: string) {
    const out: string[] = [];
    render(<RichTextEditor initialHtml={html} onChange={(h) => out.push(h)} />);
    const body = screen.getByRole('textbox', { name: 'Body' });
    const caret = (node: Node, off: number) => { const r = document.createRange(); r.setStart(node, off); r.collapse(true); const s = window.getSelection()!; s.removeAllRanges(); s.addRange(r); fireEvent(document, new Event('selectionchange')); };
    const type = (data: string) => fireEvent(body, new InputEvent('beforeinput', { inputType: 'insertText', data, cancelable: true, bubbles: true }));
    const pick = async (name: string) => { await userEvent.setup().click(screen.getByRole('button', { name: /^Text colour/ })); await userEvent.setup().click(screen.getByRole('button', { name })); };
    return { body, out, caret, type, pick };
  }
  const ind = () => screen.getByRole('button', { name: /^Text colour/ });
  const bar = () => ind().querySelector('.rte-a-bar') as HTMLElement;

  it('choosing a colour at a caret changes nothing in the text, shows it in the indicator, and colours only what is typed next', async () => {
    const { body, caret, type, pick } = setup('<p>one</p>');
    caret(body.firstChild!.firstChild!, 3);
    await pick('Red');
    expect(body.innerHTML).toBe('<p>one</p>'); // nothing recoloured
    expect(ind()).toHaveAttribute('aria-label', 'Text colour: Red');
    expect(bar().dataset.colour).toBe('#E5484D');
    type(' two'); // typed text goes into a palette span
    expect(body.innerHTML).toContain('one<span style="color: rgb(229, 72, 77);"> two</span>');
    expect(ind()).toHaveAttribute('aria-label', 'Text colour: Red'); // follows the caret after typing
    // switch to Green and type: a new span, the red one untouched
    await pick('Green');
    expect(ind()).toHaveAttribute('aria-label', 'Text colour: Green');
    type('!');
    expect(body.querySelectorAll('span')).toHaveLength(2);
    expect(body.textContent).toBe('one two!');
  });
  it('Default after a colour continues in plain text, splitting the coloured span', async () => {
    const { body, caret, type, pick } = setup('<p><span style="color:#E5484D">red</span></p>');
    const txt = body.querySelector('span')!.firstChild!;
    caret(txt, 3);
    await pick('Default');
    expect(ind()).toHaveAttribute('aria-label', 'Text colour: Default');
    type('x');
    expect(body.textContent).toBe('redx');
    const spanTexts = [...body.querySelectorAll('span')].map((s) => s.textContent);
    expect(spanTexts).toEqual(['red']); // the typed x is outside every colour span
  });
  it('moving the caret ends the pending colour and the indicator follows the character before the caret', async () => {
    const { body, caret, pick } = setup('<p>plain <span style="color:#3FB950">green</span></p>');
    caret(body.firstChild!.firstChild!, 2);
    await pick('Blue');
    expect(ind()).toHaveAttribute('aria-label', 'Text colour: Blue');
    fireEvent.mouseDown(body);
    caret(body.querySelector('span')!.firstChild!, 3);
    await vi.waitFor(() => expect(ind()).toHaveAttribute('aria-label', 'Text colour: Green'));
    caret(body.firstChild!.firstChild!, 2);
    await vi.waitFor(() => expect(ind()).toHaveAttribute('aria-label', 'Text colour: Default'));
  });
});

describe('pending size at a bare caret (A- / A+ like Word)', () => {
  function setup(html: string) {
    render(<RichTextEditor initialHtml={html} onChange={() => undefined} />);
    const body = screen.getByRole('textbox', { name: 'Body' });
    const caret = (node: Node, off: number) => { const r = document.createRange(); r.setStart(node, off); r.collapse(true); const s = window.getSelection()!; s.removeAllRanges(); s.addRange(r); fireEvent(document, new Event('selectionchange')); };
    const type = (data: string) => fireEvent(body, new InputEvent('beforeinput', { inputType: 'insertText', data, cancelable: true, bubbles: true }));
    const click = (name: RegExp | string) => userEvent.setup().click(screen.getByRole('button', { name }));
    const readout = () => document.querySelector('.rte-tb .fs')!.textContent;
    return { body, caret, type, click, readout };
  }

  it('repeated A+ steps a pending size from the current value, shows it at once, and sizes only what is typed next', async () => {
    const { body, caret, type, click, readout } = setup('<p>one</p>');
    caret(body.firstChild!.firstChild!, 3);
    const before = Number.parseInt(readout()!, 10);
    await click('Larger text'); await click('Larger text');
    expect(readout()).toBe(`${before + 2} px`);
    expect(body.innerHTML).toBe('<p>one</p>'); // nothing resized yet
    type(' two');
    expect(body.innerHTML).toContain(`one<span style="font-size: ${before + 2}px;"> two</span>`);
    expect(readout()).toBe(`${before + 2} px`); // follows the caret inside the sized text
    await click('Smaller text');
    expect(readout()).toBe(`${before + 1} px`);
    type(' three');
    expect(body.textContent).toBe('one two three');
    expect([...body.querySelectorAll('span')].map((s) => s.style.fontSize)).toEqual([`${before + 2}px`, `${before + 1}px`]);
  });
  it('clamps to the 11..20 px range', async () => {
    const { body, caret, click, readout } = setup('<p>x</p>');
    caret(body.firstChild!.firstChild!, 1);
    for (let i = 0; i < 12; i++) await click('Larger text');
    expect(readout()).toBe('20 px');
    for (let i = 0; i < 12; i++) await click('Smaller text');
    expect(readout()).toBe('11 px');
  });
  it('size and colour combine: typed text carries both on one span', async () => {
    const { body, caret, type, click } = setup('<p>a</p>');
    caret(body.firstChild!.firstChild!, 1);
    await click('Larger text');
    await userEvent.setup().click(screen.getByRole('button', { name: /^Text colour/ }));
    await userEvent.setup().click(screen.getByRole('button', { name: 'Red' }));
    type('b');
    const s = body.querySelector('span')!;
    expect(s.style.color).toBe('rgb(229, 72, 77)');
    expect(s.style.fontSize).toBe('14px');
    expect(sanitizeHtml(body.innerHTML)).toBe('<p>a<span style="font-size: 14px; color:#E5484D">b</span></p>');
  });
  it('Default colour keeps a pending size (the span is not dropped)', async () => {
    const { body, caret, type, click } = setup('<p><span style="color:#E5484D">red</span></p>');
    caret(body.querySelector('span')!.firstChild!, 3);
    await click('Larger text');
    await userEvent.setup().click(screen.getByRole('button', { name: /^Text colour/ }));
    await userEvent.setup().click(screen.getByRole('button', { name: 'Default' }));
    type('x');
    const xs = [...body.querySelectorAll('span')].find((s) => s.textContent === 'x')!;
    expect(xs.style.fontSize).toBe('14px');
    expect(xs.style.color).toBe('');
    expect(xs.closest('span[style*="color"]')).toBeNull(); // split out of the red span
  });
  it('Clear formatting at a caret makes the next text plain (13 px, default colour)', async () => {
    const { body, caret, type, click, readout } = setup('<p>one <span style="font-size: 18px">big</span></p>');
    caret(body.querySelector('span')!.firstChild!, 3);
    await click('Larger text');
    await click(/Clear formatting/);
    expect(readout()).toBe('13 px');
    type('z');
    const z = [...body.querySelectorAll('span')].find((x) => x.textContent === 'z')!;
    expect(z.style.fontSize).toBe('13px');
    expect(z.style.color).toBe('');
  });
});
