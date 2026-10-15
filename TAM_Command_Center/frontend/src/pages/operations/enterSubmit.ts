import type { KeyboardEvent } from 'react';

const TEXTLIKE = new Set(['text', 'search', 'number', 'date', 'email', 'url', 'tel']);

/**
 * Plain Enter inside a single-line text input submits the dialog (the submit handler validates itself).
 * Ignores textareas (Enter = new line), buttons and Select triggers (Enter opens/chooses), IME composition and modified keys.
 */
export function enterSubmit(submit: () => void, busy = false) {
  return (e: KeyboardEvent<HTMLElement>) => {
    if (e.key !== 'Enter' || e.defaultPrevented || e.nativeEvent.isComposing || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
    const t = e.target;
    if (!(t instanceof HTMLInputElement) || !TEXTLIKE.has(t.type)) return;
    e.preventDefault();
    if (!busy) submit();
  };
}
