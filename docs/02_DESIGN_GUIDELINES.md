# 02 Design Guidelines: TAM Command Center

| | |
|---|---|
| Author | pm-agent (Phase 1.1) |
| Date | 2026-10-12 |
| For | frontend-dev-agent (2.2, 2.3); QA uses it as the visual and accessibility checklist |
| Sources | `docs/SPEC.md` §6, §43, §44, §49, §54, §55; decisions in `docs/01_PM_SPEC.md` §0 |

**Principle:** this is a Bloomberg-inspired operational console. It is dark, dense and calm, and amber means "you can act here". Where clarity and decoration conflict, clarity wins (§55). Implement everything below with custom CSS custom properties. Tailwind and UI kits are not allowed. Icons come from `lucide-react` (D-14).

---

## 1. Tokens

Define these once in `frontend/src/styles/tokens.css` on `:root`. Components reference tokens only and never contain raw hex values. QA will grep for hex outside `tokens.css`.

### 1.1 Colour
Contrast values were computed against WCAG 2.x formulas.

| Token | Value | Use | Contrast |
|---|---|---|---|
| `--bg` | `#0B0D10` | App background, rail | n/a |
| `--surface-1` | `#11151B` | Page panels, tables, context rail | n/a |
| `--surface-2` | `#171C24` | Raised: drawers, dialogs, manual note entries, hovered rows | n/a |
| `--surface-3` | `#1F2630` | Inputs, secondary buttons, popups, selected rows | n/a |
| `--border` | `#2B3441` | Dividers, table lines, panel edges (decorative) | 1.2 to 1.6 |
| `--border-strong` | `#3D4A5C` | Panel outlines, active tab underline track | n/a |
| `--border-control` | `#647186` | Input, select and secondary-button boundaries (WCAG 1.4.11) | ≥3.08 on all surfaces |
| `--text` | `#E6E9EE` | Primary text | ≥12.5 |
| `--muted` | `#9AA3B0` | Secondary text, labels, placeholders, inactive nav | ≥5.98 |
| `--subtle` | `#6B7482` | Disabled text and zero values only (not for anything that must be read) | 3.2 to 4.1 |
| `--accent` | `#FA9A28` | Primary actions, active nav, selected state, links in nav context | ≥7.05 |
| `--accent-hover` | `#FFB052` | | |
| `--accent-press` | `#DB8318` | | |
| `--on-accent` | `#0B0D10` | Text and icons on accent fills | 9.0 |
| `--accent-tint` | `rgba(250,154,40,0.12)` | Selected row or option background, active nav background | n/a |
| `--info` | `#5AAEFF` | Hyperlinks, In Progress, informational | ≥6.48 |
| `--success` | `#3FC77F` | Complete, Passed, healthy, Live | ≥7.03 |
| `--warning` | `#E8C547` | Waiting, caution, BAMS Warning, Delayed, Validation Required | ≥9.08 |
| `--danger` | `#FF5C5C` | Overdue, Critical, Failed, destructive actions | ≥5.03 |
| `--neutral` | `#9AA3B0` | Not Started, Deferred, No Data | = muted |
| `--focus` | `#7CC4FF` | Focus ring (separate from accent so it shows on amber buttons) | ≥8.1 |
| `--*-tint` | each status colour at 0.12 alpha | Badge backgrounds | n/a |
| `--scrim` | `rgba(0,0,0,0.6)` | Behind dialogs and drawers | n/a |

**Accent vs warning:** accent is orange (`#FA9A28`) and warning is yellow-amber (`#E8C547`). They must never be the only difference between two meanings. A warning state always carries a text label, such as "Waiting".

**Banned:** purple, gradients, glassmorphism and backdrop blur, white surfaces, and coloured page backgrounds.

### 1.2 Typography
- Sans: `"Segoe UI Variable Text", "Segoe UI", system-ui, -apple-system, sans-serif`.
- Mono: `"Cascadia Mono", Consolas, "SF Mono", monospace`. Use it only for identifiers: BPID, server/appliance names, versions, tickers, IDs.
- `font-variant-numeric: tabular-nums` applies to every date, time, count and version cell (`.num` utility and on `DataTable` numeric columns).

| Token | Size / line height | Weight | Use |
|---|---|---|---|
| `--fs-label` | 11px / 16px, uppercase, `letter-spacing: 0.06em` | 600 | Section labels, technical metadata, table headers |
| `--fs-sm` | 12px / 16px | 400 | Secondary row text, badges, timestamps |
| `--fs-base` | 13px / 20px | 400 | Body text, table cells, inputs, buttons |
| `--fs-md` | 14px / 20px | 600 | Panel titles, drawer section titles |
| `--fs-lg` | 16px / 24px | 600 | Dialog and drawer titles |
| `--fs-xl` | 20px / 28px | 600 | Page title and account name (maximum size; no marketing headings) |

### 1.3 Spacing, radius, elevation, motion
- **Spacing** uses a 4px scale: `--sp-1:4px --sp-2:8px --sp-3:12px --sp-4:16px --sp-5:20px --sp-6:24px --sp-8:32px`.
- **Radius:** `--r-sm:2px` (badges), `--r-md:4px` (buttons, inputs, popups), `--r-lg:6px` (panels, dialogs). Nothing rounder. No pills except the segmented control track.
- **Elevation:** surfaces are separated by colour and a 1px border, not shadows. The only shadow is `--shadow-pop: 0 8px 24px rgba(0,0,0,0.5)`, on popups, dialogs and drawers.
- **Motion:** `--dur: 120ms` with `ease-out`, applied only to colour, border, opacity and drawer/dialog entry (opacity plus 8px translate). Hover never moves or scales elements. `@media (prefers-reduced-motion: reduce)` sets all durations to 0ms.

---

## 2. Density and layout

| Element | Size |
|---|---|
| Top bar | 48px |
| Nav rail | 208px expanded, 56px collapsed (below 1280px), item 36px high |
| Page gutter | 24px (16px below 1024px) |
| Table row | 32px (`compact`, the default) or 40px (`comfortable`, for two-line rows such as the Today queue) |
| Table header | 32px, sticky, `--surface-1` with a `--border` bottom line |
| Control height | 32px (md, default) or 28px (sm, in table rows and filter bars) |
| Drawer width | 480px (full width below 640px) |
| Dialog width | 600px for Quick Capture, 440px for confirm dialogs |
| Context rail | 320px; the Today right column is 360px |

**Breakpoints:** 1440 (wide), 1280 (the rail collapses), 1200 (the Today right column drops below the queue), 1100 (the Account context rail becomes a collapsible "Account brief"), 1024 (gutters tighten), 768 (minimum supported; tables scroll horizontally inside their container). The page never scrolls horizontally at 768px and above. Primary work (the Today queue, the Account tabs and their content) is never hidden or collapsed. Secondary context collapses first (§44).

**Panels:** a `--surface-1` background, 1px `--border`, `--r-lg` radius, and a 12px/16px internal header with a `--fs-label` title. Do not nest cards inside cards. The Account context rail is **one** panel whose sections are separated by `--border` dividers (§10, §49).

---

## 3. Iconography
- Lucide line icons, `strokeWidth={1.5}`. Sizes: 16px inline, in buttons and in tabs; 18px in the nav rail; 14px inside badges, used sparingly.
- **Colour:** icons inherit `currentColor`. The active nav icon uses `--accent`. Inactive icons use `--muted`.
- **Icons never stand alone as meaning (§43).** Nav items have visible labels. In the collapsed rail they have an `aria-label` plus a tooltip. Icon-only buttons have an `aria-label` and a tooltip. Status icons always sit next to text.
- Purely decorative icons get `aria-hidden="true"`.

| Concept | Lucide icon |
|---|---|
| Today | `calendar-check` |
| Accounts | `building-2` |
| Tasks | `list-checks` |
| Operations | `server-cog` |
| BAMS | `activity` |
| ChatGPT Bridge | `messages-square` |
| Settings | `settings` |
| Tab: Overview | `layout-dashboard` |
| Tab: Tasks | `list-checks` |
| Tab: Activity | `history` |
| Tab: Infrastructure | `server` |
| Tab: Contacts | `users` |
| Meeting Note | `users-round` |
| Call Note | `phone` |
| General Note | `file-text` |
| System event | `cog` |
| BAMS alert | `siren` |
| Upgrade | `arrow-up-circle` |
| Capture | `plus` |
| Search / jump | `search` |
| Row chevron | `chevron-right` |
| Primary contact | `star` (filled = primary) |
| Waiting | `hourglass` |
| Overdue | `alarm-clock` |
| Edit | `pencil` |
| Delete | `trash-2` |
| Archive | `archive` |
| Complete | `check-circle-2` |
| Backup | `database-backup` |
| Refresh | `refresh-cw` |

---

## 4. Status language

There is one mapping, used everywhere (implemented in `StatusBadge`). Badges are compact: 18px high, `--fs-sm`, `--r-sm`, tinted background, and coloured text with an optional 14px icon. Use at most **one** badge per row. Overdue is shown on the date cell, not as an extra badge.

| Domain | Value | Colour |
|---|---|---|
| Task status | Not Started | neutral |
| | In Progress | info |
| | Waiting | warning (+ hourglass) |
| | Complete | success |
| Task priority | High | `PriorityLabel`: accent text with `▲` glyph |
| | Medium | muted text with `●` glyph |
| | Low | subtle text with `▽` glyph |
| Due date | overdue | danger text, plus "Nd overdue" in `--fs-sm` |
| | today | accent text "Today" |
| | future | text, plus muted relative label |
| BAMS event | open Critical | danger |
| | open Warning | warning |
| | open Info | info |
| | recovered (awaiting close) | neutral with label "Recovered · close pending" |
| Upgrade status | Planned, Scheduled | neutral |
| | Awaiting Client | warning |
| | In Progress | info |
| | Validation Required | warning |
| | Completed | success |
| | Deferred | neutral |
| | Exception | danger |
| Validation | Pending | warning |
| | Passed | success |
| | Failed | danger |
| | Not Required | neutral |
| Account status | Inactive | neutral badge next to the name; Active shows no badge |
| Environment | DEV | `DEV` badge in the top bar, warning tint, always visible in DEV mode |

---

## 5. Buttons

Variants: `primary` (accent fill), `secondary` (surface-3 with `--border-control`), `ghost` (transparent), `danger` (danger outline that fills on hover), and `icon` (ghost, square 28/32px). Sizes are sm (28px) and md (32px), with 12px horizontal padding and a 6px gap between icon and label. Labels use sentence case and a verb ("Save task", "Delete note").

| State | primary | secondary | ghost / icon | danger |
|---|---|---|---|---|
| default | bg `--accent`, text `--on-accent` | bg `--surface-3`, border `--border-control`, text `--text` | text `--muted` | border `--danger`, text `--danger`, transparent bg |
| hover | bg `--accent-hover` | border `--muted`, bg `--surface-2` | text `--text`, bg `--surface-3` | bg `--danger`, text `--on-accent` |
| active (pressed) | bg `--accent-press` | bg `--bg` | bg `--surface-2` | bg darker danger (`filter: brightness(0.9)`) |
| disabled | `opacity: 0.4`, `cursor: not-allowed`, no hover change; uses the `disabled` attribute, or `aria-disabled` when the button must stay focusable for a tooltip | same | same | same |
| focus-visible | `outline: 2px solid var(--focus); outline-offset: 2px` | same | same | same |
| busy | label replaced by "Saving…", `aria-busy="true"`, width locked | | | |

Global reset: `button, input, select, textarea { font: inherit; color: inherit; }` and `button { appearance: none; background: none; border: 0; }`. **No user-agent button styling may ever render (§49).** Use `:focus-visible` only; mouse clicks do not show the ring.

Links: `--info` text, underlined on hover, with focus ring. Account-name links inside tables use `--text` with an underline on hover, so a table is not a sea of blue.

---

## 6. Dropdowns: the custom select and the account picker

Native `<select>` popups are banned (§6, §49). Two components cover every case.

### 6.1 `Select` (select-only combobox)
Follows the WAI-ARIA APG "Select-Only Combobox" pattern.

**DOM and ARIA:**
- Trigger: `div` or `button` with `role="combobox"`, `aria-haspopup="listbox"`, `aria-expanded`, `aria-controls=<listbox id>`, and `aria-labelledby` pointing at the visible label.
- `aria-activedescendant` points at the active option while the list is open.
- Listbox: `role="listbox"`. Options: `role="option"` with `aria-selected`. Disabled options use `aria-disabled`.
- A hidden `<input type="hidden" name=…>` mirrors the value, so the component works with forms and keeps a select-compatible data model.
- Props: `value`, `onChange`, `options: {value, label, disabled?, icon?}[]`, `placeholder`, `clearable` (adds a "None" option at the top for nullable fields), `size`, `name`, `id`, `disabled`.

**Visuals:**
- The trigger looks like an input: surface-3, `--border-control`, `chevron-down` on the right, value text, and `--muted` placeholder.
- The popup is rendered in a portal, with surface-3, a `--border-strong` 1px border, `--shadow-pop` and `--r-md`. It is at least as wide as the trigger, at most 360px wide, with a 280px maximum height that scrolls.
- Option rows are 28px. Hover or active option: `--surface-2` background with `--text`. The selected option shows a `check` icon (16px, `--accent`) on the left in a reserved 16px column, so labels do not shift.

**Keyboard (all required; Vitest covers each row):**

| Key | Closed | Open |
|---|---|---|
| Down / Up | Opens, with the selected option (or the first) active | Moves the active option (no wrap) |
| Alt+Down | Opens without moving | n/a |
| Alt+Up | n/a | Selects the active option and closes |
| Home / End | Opens, with the first or last option active | Moves to the first or last option |
| PageUp / PageDown | n/a | Moves 10 options |
| Enter / Space | Opens | Selects the active option and closes; focus returns to the trigger |
| Escape | No-op (does not bubble to close a dialog) | Closes without changing the value; focus stays on the trigger. Stops propagation so the parent dialog stays open. |
| Tab / Shift+Tab | Normal focus move | Selects the active option, closes, and moves focus (APG behaviour) |
| Printable characters | Type-ahead: jumps to the first matching option (500ms buffer) and opens | Type-ahead moves the active option |

**Mouse:** clicking the trigger toggles the list. Clicking an option selects it and closes the list. Clicking outside closes it without changing the value.

**Positioning:** the list opens below the trigger by default. If the space below is less than the list height plus 8px and there is more space above, it flips above. It repositions on scroll and resize while open, and closes if the trigger scrolls out of view. It clamps horizontally inside the viewport with an 8px margin. The active option is scrolled into view (`block: "nearest"`).

### 6.2 Segmented control
Used for 2 to 5 mutually exclusive, always-visible options (Activity filter, Quick Capture type, Local/GMT). It uses `role="radiogroup"` with `role="radio"` items. Arrow keys move the selection and roving tabindex. The selected segment has a `--accent-tint` background, `--accent` text and a `--border-control` track. Prefer this over a Select when there are 5 options or fewer and space allows.

### 6.3 `AccountPicker` (editable combobox, list autocomplete)
- Follows the APG "Editable Combobox with List Autocomplete" pattern, used for the account jump (Ctrl+K), Quick Capture and the task editor.
- An input with `role="combobox"`, `aria-autocomplete="list"` and `aria-expanded`. It filters accounts by case-insensitive substring on name and BPID, and bolds the matched substring.
- Down/Up move through the options. Enter selects. Escape clears the typed text first, then closes on a second press. Tab accepts the active option only if one is active.
- With no matches it shows "No accounts match". Inactive accounts appear last, with an "Inactive" label.
- When nullable (task editor), the top option is "No account".
- It uses the same popup surface and positioning rules as §6.1.

---

## 7. Forms
- Every field has a visible `<label>` above it in `--fs-sm` `--muted`. Required fields show a `*` and `aria-required`.
- Inputs are 32px high, with surface-3, `--border-control` and `--r-md`. Hover uses a `--muted` border. Focus uses a `--focus` 2px outline. Errors use a `--danger` border, and the message below is linked by `aria-describedby`.
- Textareas grow automatically from 3 to 12 rows.
- Dates use native `type="date"` or `datetime-local` with `color-scheme: dark` on `:root` (D-15). Quick chips (Today, Tomorrow, +1 week) appear as `ghost` sm buttons beside the input.
- Validation runs on blur and on submit. On submit, focus moves to the first invalid field. Server `fields` errors map onto the matching inputs.
- **Unsaved changes:** closing a dirty drawer or dialog prompts "Discard changes?" with Discard (danger) and Keep editing (primary).
- Save shortcut: Ctrl+Enter inside a drawer or dialog.

---

## 8. Tables (`DataTable`)
- Uses native `<table>`, `<thead>`, `<th scope="col">`. Sortable headers contain a `button` and the `th` carries `aria-sort`. The table has a `<caption>`, which may be visually hidden.
- The header is sticky inside a scroll container (`overflow:auto`), so tables scroll horizontally inside their own box (§44).
- Text columns are left-aligned. Numbers, counts and dates are right-aligned with tabular numerals. Versions and server names use mono.
- Rows: a 1px `--border` bottom line. Hover gives a `--surface-2` background and reveals the `chevron-right` (muted) in the last column. The selected or highlighted row (e.g. `?server=`) gets an `--accent-tint` background and a 2px `--accent` left inset.
- **Row navigation:** the whole row is clickable. For keyboard use, the primary cell holds the real `<a>` or `<button>` (no `tabindex` on `<tr>`). Hover action buttons (e.g. Mark complete) are also visible on `:focus-within`.
- No zebra striping. A zero renders as `0` in `--subtle`. An empty value renders as `-` in `--subtle`.
- Long text is truncated with an ellipsis. The full text goes in the `title` attribute and the editor.

---

## 9. Activity: manual notes vs system events (§10, §12)

They must be distinguishable at a glance, and also without colour.

| | Manual note (`NoteEntry`) | System event (`SystemEventEntry`) |
|---|---|---|
| Container | `--surface-2` block with 12px padding and a 2px left border in the type colour (Meeting = accent, Call = info, General = muted) | No container. A single 28px line inside the timeline |
| Header | Type icon + type label ("Meeting note") + timestamp + subject in `--fs-md` | `cog` icon + "System" label (`--fs-label`, muted) + timestamp |
| Body | Body text (6-line clamp, "Show more"), then an "Action items" sub-block | Generated sentence in `--muted` `--fs-sm` (e.g. "Task completed: Send entitlement summary") |
| Actions | Edit (pencil) and Delete (trash), visible on hover or focus-within | **None.** Not focusable unless it carries a link to the referenced object |
| Source | A tag only when it is not `GUI` | n/a |

Timeline grouping: day headings in `--fs-label` ("TODAY", "YESTERDAY", "FRI 09 OCT").

---

## 10. Overlays

| Overlay | Rules |
|---|---|
| **Dialog** | `role="dialog"`, `aria-modal="true"`, `aria-labelledby`. Focus goes to the first field, or to the least-destructive button for confirm dialogs. Focus is trapped. Escape closes it (with the dirty check). Clicking the scrim closes it only if it is not dirty. Focus returns to the invoker. Body scroll is locked. |
| **Drawer** | Same rules as a dialog, sliding in from the right. The URL query (`?task=`) reflects the open object, so Back closes it. |
| **Confirm delete** | Title "Delete <object>?", the object name in bold, the safety-backup sentence, and the buttons Cancel (secondary, focused by default) and "Delete <object>" (danger). Account delete adds a type-to-confirm input and keeps the danger button disabled until the name matches exactly. |
| **Toasts** | Bottom-right, stacked, max 3, 360px wide, surface-2 with a left border in the status colour. Success and info dismiss after 4s; errors stay until dismissed. The container is `aria-live="polite"`, or `assertive` for errors. A toast may carry one action ("View", "Undo" is not offered). No browser title changes and no tab flashing (§28). |
| **Tooltips** | Appear after 400ms on hover and immediately on focus. They use `role="tooltip"` via `aria-describedby`, `--fs-sm`, and a surface-3 background. |

---

## 11. Navigation shell
- **Rail:** `--bg` background with a `--border` right edge. Items are 36px high: icon, label, and an optional "Later" tag (`--fs-label`, `--subtle`, bordered). The active item has a 2px `--accent` bar on the left edge, an `--accent-tint` background, and an accent icon and label. Hover gives a `--surface-2` background. Settings is pinned to the bottom. The rail is a `<nav aria-label="Primary">` with `aria-current="page"` on the active item.
- **Top bar:** `--surface-1` background with a `--border` bottom edge. From left to right: account jump (looks like a search input, with a `Ctrl+K` hint), flexible space, `DEV` badge (DEV mode only), clock (local or GMT per setting, with a "GMT" suffix when GMT is selected), "+ Capture" (primary button, sm).
- **Account tabs:** APG tabs with automatic activation and arrow-key navigation. The active tab has `--text` with a 2px `--accent` underline. Inactive tabs are `--muted`. Each tab shows an icon, a label and an optional count (`--fs-sm`, muted, tabular).
- **Global shortcuts:** `Ctrl+K` opens the account jump. `N` opens Quick Capture, ignored when focus is in an input, textarea or contenteditable. `?` shows a shortcut list (nice to have). Shortcuts must never fire inside form fields.

---

## 12. Screen states

Every data view implements all of these. QA checks each one.

| State | Treatment |
|---|---|
| Loading (first load) | Skeleton rows in surface-2 (no shimmer when reduced motion is set), shown only after 300ms to avoid flicker. No full-page spinners. |
| Refreshing | Existing data stays. A small `refresh-cw` spinner appears next to "Last refreshed". |
| Empty | One muted sentence plus the single relevant primary action, e.g. "No open tasks for this account." with "+ Task". No illustrations. |
| Error | An inline `ErrorBanner` in the panel (danger left border): the message, a "Retry" action and a "Details" disclosure with the error code. The rest of the page keeps working. |
| Stale / offline | If a refresh fails but earlier data exists, keep showing it with a `StaleDataBanner`: "Showing data from 14:05. Reconnecting…" (§55: cached data clearly marked as cached). |
| Saving | The button shows its busy state and the form is disabled. On success a toast appears. On failure a field or inline error appears and the user's input is kept. |
| Conflict (409 `stale_write`) | Inline banner: "This item changed elsewhere." with the actions Reload (discards your edit) and Overwrite. |
| Not implemented (501) | Never shown for in-scope screens. Placeholder pages handle unbuilt areas. |

---

## 13. Formatting
- **Dates:** `DD MMM` in the current year, otherwise `DD MMM YYYY`, for example `12 Oct` or `03 Jan 2027`. In the Today and Upcoming headings: `Mon 12 Oct`.
- **Relative labels:** "Today", "Tomorrow", "in 3d", "2d overdue", "5d ago". Relative labels always sit next to the absolute date, never replace it, and use `--fs-sm` muted text (danger for overdue).
- **Timestamps:** `12 Oct 14:05` in local time, or `12 Oct 18:05 GMT` when the setting is GMT. Use a 24-hour clock.
- **Counts:** integers with no abbreviation below 10,000.
- **Copy tone:** plain, operational and specific. Sentence case. No exclamation marks, emoji or marketing language. Error text says what happened and what to do next.

---

## 14. Do / Don't checklist (QA visual pass)

**Do:**
- Use tokens only.
- Show every button state.
- Use the custom Select everywhere.
- Use tabular numerals on dates and numbers.
- Use a single continuous context rail.
- Keep manual notes and system events distinct.
- Show the focus ring on every interactive element.
- Keep the DEV badge visible in DEV mode.
- Use the empty, error and stale states.

**Don't:**
- Native white buttons or select popups
- Gradients, purple, glassmorphism or blur
- Large rounded cards or card-in-card layouts
- Badges on every cell
- Health scores or sales fields
- Hover-move animations
- Headings larger than 20px
- Icons without a text equivalent
- Title or tab flashing for alerts
- Raw HTML rendering of user text (use `RichText`)
