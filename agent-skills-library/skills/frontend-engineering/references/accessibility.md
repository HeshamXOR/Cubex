# Accessibility reference (WCAG 2.2 AA)

## Contents
1. Ground rules
2. Semantics and structure
3. Keyboard and focus
4. Forms
5. Color, contrast, motion
6. ARIA rules
7. Common widgets
8. What is new in WCAG 2.2
9. Testing routine

## 1. Ground rules

- Target **WCAG 2.2 Level AA**. It is the version most current regulations and procurement documents cite, and it is backward compatible with 2.0 and 2.1 (the only removal is 4.1.1 Parsing).
- Native HTML first. A native `button`, `a`, `input`, `select`, `details`, or `dialog` brings keyboard behavior, roles, and states for free.
- Accessibility is checked with three tools together: automated scan (finds roughly a third of issues), keyboard-only run, and screen reader spot check.

## 2. Semantics and structure

- One `h1` per page; heading levels descend without skipping. Headings describe structure, not size.
- Landmarks: `header`, `nav` (label multiple navs with `aria-label`), `main` (one per page), `aside`, `footer`.
- Provide a "Skip to main content" link as the first focusable element.
- Set `lang` on `html` and on inline foreign-language passages. Set `dir="rtl"` where needed.
- Every image has `alt`. Informative images: describe purpose. Decorative: `alt=""`. Complex charts: short alt plus a text or table alternative.
- Links have meaningful text ("Download the 2026 report", not "Click here"). Links navigate; buttons act.
- Tables: `caption`, `th` with `scope`, no layout tables.
- Page `title` is unique and descriptive; update it on client-side route changes and move focus to the new page heading or main region.

## 3. Keyboard and focus

- Every interactive element is reachable and operable by keyboard: Tab, Shift+Tab, Enter, Space, Arrow keys for composite widgets, Escape to dismiss.
- Never use positive `tabindex`. Use `tabindex="0"` only for custom widgets and `tabindex="-1"` for programmatic focus targets.
- Keep a visible focus indicator with at least 3:1 contrast against adjacent colors. Style with `:focus-visible`; never `outline: none` without a replacement.
- **Focus not obscured (2.4.11, AA)**: sticky headers, cookie banners, and chat widgets must not fully cover the focused element. Use `scroll-padding-top` on `html` equal to the sticky header height.
- Modals: move focus in on open, trap it inside (native `dialog.showModal()` does this), close on Escape, return focus to the trigger on close, and make the background inert.
- SPA route changes: manage focus and announce the new page.
- No keyboard traps. No time limits without extend or disable options.

## 4. Forms

- Programmatic label for each control (`label for`, wrapping label, or `aria-labelledby`). Group related controls in `fieldset` with `legend` (radios, checkboxes).
- Mark required fields in text ("required" or "(optional)") and with `required` or `aria-required`; do not rely on color or an asterisk alone.
- Errors: identify the field, describe the problem, suggest a fix, link via `aria-describedby`, set `aria-invalid="true"`, and announce a summary through a live region or by moving focus to it.
- Use `autocomplete` tokens (`email`, `given-name`, `one-time-code`, `current-password`, `new-password`).
- **Redundant entry (3.3.7, A)**: do not make users retype information they already provided in the same flow.
- **Accessible authentication (3.3.8, AA)**: do not require solving a cognitive test (remembering a password, transcribing characters, puzzles) without an alternative. Allow paste and password managers; support passkeys, email links, or WebAuthn.

## 5. Color, contrast, motion

- Text contrast: 4.5:1 normal, 3:1 for large text (18pt or 14pt bold and up).
- Non-text contrast (icons that convey meaning, input borders, focus rings, chart series boundaries): 3:1.
- Never convey information by color alone (add icon, text, or pattern).
- Support 200% zoom and 400% reflow at 320 CSS px width without two-dimensional scrolling. Use relative units (`rem`, `em`, `%`) for type and spacing.
- Respect `prefers-reduced-motion: reduce`: remove parallax, large transitions, autoplay. Nothing flashes more than 3 times per second.
- Respect `prefers-color-scheme` and `forced-colors` (Windows high contrast): use system colors for borders and focus where custom ones vanish.
- Text spacing overrides (line height 1.5, letter spacing 0.12em, word spacing 0.16em) must not clip or overlap content: avoid fixed heights on text containers.

## 6. ARIA rules

1. Do not use ARIA if a native element does the job.
2. Do not change native semantics (no `<h2 role="button">`).
3. All interactive ARIA controls must be keyboard operable.
4. Do not hide focusable elements (`aria-hidden="true"` or `display:none` on something focusable).
5. Every interactive element needs an accessible name (visible text, `aria-label`, or `aria-labelledby`).
- Icon-only button: `<button aria-label="Close"><svg aria-hidden="true">...</svg></button>`.
- State attributes must stay in sync with reality: `aria-expanded`, `aria-selected`, `aria-current`, `aria-pressed`, `aria-checked`.
- Live regions: `role="status"` (polite) for saves and counts, `role="alert"` (assertive) for errors. The region must exist in the DOM before its content changes.
- Prefer visible text over `aria-label`; `aria-label` is not translated by many tools and is invisible to voice-control users when it differs from visible text (label in name, 2.5.3).

## 7. Common widgets

| Widget | Preferred approach |
|---|---|
| Modal | `<dialog>` with `showModal()`, labelled by heading |
| Disclosure or accordion | `<details>/<summary>` or button with `aria-expanded` controlling a region |
| Tabs | `role=tablist/tab/tabpanel`, roving tabindex, Arrow keys switch tabs |
| Menu button | Button with `aria-haspopup` and `aria-expanded`; Arrow keys, Escape; do not use `role=menu` for site navigation |
| Combobox or autocomplete | Follow the ARIA APG combobox pattern; consider a proven library (Radix, React Aria, Headless UI, Ark) |
| Toast | `role=status`; do not auto-dismiss messages that need action; give enough time |
| Tooltip | Appears on focus and hover, dismissible with Escape, hoverable |
| Drag and drop | Provide a non-dragging alternative (**2.5.7 Dragging Movements, AA**): move up/down buttons or keyboard reorder |
| Data table | Sortable header buttons with `aria-sort`; keep semantics of `table` |

For complex widgets prefer a headless, accessible primitive library over hand-rolling.

## 8. What is new in WCAG 2.2

| SC | Level | Meaning in practice |
|---|---|---|
| 2.4.11 Focus Not Obscured (Minimum) | AA | Focused element is not entirely hidden by sticky or overlay content |
| 2.4.12 Focus Not Obscured (Enhanced) | AAA | No part of the focused element hidden |
| 2.4.13 Focus Appearance | AAA | Focus indicator of sufficient size and contrast |
| 2.5.7 Dragging Movements | AA | Every drag action has a single-pointer alternative |
| 2.5.8 Target Size (Minimum) | AA | Pointer targets at least 24 by 24 CSS px, unless spacing, inline, equivalent, user-agent, or essential exceptions apply; aim for 44 by 44 |
| 3.2.6 Consistent Help | A | Help links, contact, or chat appear in the same place across pages |
| 3.3.7 Redundant Entry | A | Do not require re-entering information already given in the process |
| 3.3.8 Accessible Authentication (Minimum) | AA | No cognitive function test without an alternative or assistance |
| 3.3.9 Accessible Authentication (Enhanced) | AAA | Stricter version of 3.3.8 |

## 9. Testing routine

1. Run axe (browser extension, `@axe-core/playwright`, or `jest-axe`) and Lighthouse accessibility. Fix all violations.
2. Unplug the mouse. Complete the primary flow with Tab, Shift+Tab, Enter, Space, Arrows, Escape. Watch for lost focus, invisible focus, traps.
3. Zoom to 200% and 400%. Check reflow at 320px.
4. Use a screen reader on the main flow: NVDA or JAWS on Windows, VoiceOver on macOS and iOS, TalkBack on Android. Listen for names, roles, states, and error announcements.
5. Turn on reduced motion, high contrast, and dark mode.
6. Add regression tests: query by role and accessible name in Testing Library (`getByRole('button', { name: 'Save' })`); a query that cannot find the element by role often reveals an accessibility bug.
