---
name: frontend-engineering
description: Builds, reviews, and refactors production-quality frontend code (HTML, CSS, JavaScript/TypeScript, React and similar component frameworks) with accessibility, performance, responsiveness, and design quality built in. Use whenever the task involves a UI, web page, component, form, layout, styling, client-side state, data fetching in the browser, Core Web Vitals, WCAG accessibility, dark mode, RTL or i18n layouts, or turning a design or idea into working interface code, even if the user does not say the word frontend.
license: MIT
metadata:
  category: engineering
  version: "1.0"
---

# Frontend Engineering

Build interfaces that are correct, accessible, fast, and pleasant. Follow the project's existing conventions first; use the defaults below only where the project is silent.

## 0. Before writing code

1. Inspect the project: `package.json`, framework and version, router, styling approach (CSS modules, Tailwind, CSS-in-JS, design tokens), component library, lint and format config, test runner. Match all of it.
2. Find the nearest existing component that resembles the task and copy its structure, naming, and file layout.
3. Confirm the states the UI must handle. Every data-driven view has at least: loading, empty, error, success, and partial or stale.
4. Confirm target browsers, devices, languages (LTR and RTL), and whether SEO or server rendering matters.

## 1. Build order

Work in layers. Each layer must be usable before the next is added.

1. **Semantic HTML**: landmarks (`header`, `nav`, `main`, `footer`), headings in order, `button` for actions, `a` for navigation, `label` for every input, `ul`/`ol` for lists, `table` for tabular data, `dialog` for modals.
2. **Layout and styling**: mobile-first, design tokens, fluid spacing and type, logical properties (see `references/css-and-layout.md`).
3. **Behavior**: state, events, data fetching, validation.
4. **Polish**: focus states, hover and active states, transitions that respect `prefers-reduced-motion`, empty states, skeletons.
5. **Verification**: keyboard pass, screen-reader spot check, responsive pass at 320px, 768px, 1280px, slow-network and error pass.

## 2. Component design rules

- One component, one responsibility. Split when a file exceeds roughly 200 lines or mixes data fetching with presentation.
- Props are the public API. Keep them few, typed, and named for meaning (`isDisabled`, `onSubmit`), not implementation.
- Prefer composition (`children`, slots, render props) over configuration props with many booleans. More than 3 boolean props signals the need for variants or composition.
- Presentational components take data and callbacks. Containers or hooks own fetching and side effects.
- Never mutate props or state. Derive values during render instead of storing them.
- Keys in lists must be stable IDs, never array indexes for reorderable lists.
- Make illegal states unrepresentable: use a status union (`idle | loading | success | error`) instead of parallel booleans.

## 3. State placement (decide in this order)

| Kind of state | Where it lives |
|---|---|
| Server data (users, orders) | A server-state cache (TanStack Query, SWR, framework loaders), not `useState` plus effects |
| URL-shareable state (filters, tab, page, search) | The URL (search params or route params) |
| Form state | The form library or uncontrolled inputs with form actions; validate on the server as well |
| Local UI state (open, hover, draft) | `useState` in the lowest component that needs it |
| Shared UI state across distant components | Context or a small store (Zustand, Redux Toolkit); keep it minimal |
| Derived state | Compute during render; memoize only after measuring |

## 4. Data fetching

- Fetch on the server or in route loaders when the framework supports it; avoid client waterfalls (fetch A, then B that could have run in parallel).
- Always handle: loading, error with retry, empty result, aborted request (use `AbortController` or the cache library's cancellation).
- Never trust API shapes. Validate at the boundary (Zod, Valibot, or generated types plus runtime checks).
- Optimistic updates need rollback on failure and a visible error.
- Debounce search input (200 to 400 ms) and cancel stale requests.

## 5. Forms

- Every input has a visible `<label>`; placeholder is not a label.
- Use correct `type`, `autocomplete`, `inputmode`, and `name` attributes so browsers and password managers help.
- Validate on blur or submit, not on every keystroke, unless the field is a live-availability check. Show the error next to the field, link it with `aria-describedby`, and move focus to the first invalid field on failed submit.
- Disable the submit button only while submitting (and keep it focusable state accessible), not to signal invalid input.
- Prevent double submission. Preserve user input on error.
- Client validation is convenience; the server is the authority.

## 6. Design quality

A working UI is not automatically a good one. Make deliberate choices:

- **Hierarchy**: one clear primary action per view; size, weight, and contrast should reflect importance.
- **Type**: 1 or 2 families, a modular scale (for example 1.2 to 1.25 ratio), line-height 1.4 to 1.6 for body, measure of 45 to 75 characters.
- **Spacing**: a single scale (4 or 8 px base). Consistent rhythm beats clever values.
- **Color**: define tokens (`--color-bg`, `--color-text`, `--color-accent`, semantic success/warn/danger). Text contrast at least 4.5:1, large text and UI boundaries at least 3:1. Support dark mode with redefined tokens, not inverted filters.
- **Motion**: purposeful and short (150 to 300 ms), never the only signal, disabled or reduced under `prefers-reduced-motion`.
- **Density and touch**: touch targets at least 44 by 44 CSS px where possible (WCAG 2.2 AA minimum is 24 by 24).
- Avoid generic defaults (default system-blue buttons on white, unstyled focus rings, lorem ipsum). Choose an aesthetic direction that fits the product and apply it consistently.

## 7. Definition of done

- [ ] Works with keyboard only; visible focus; logical tab order; no keyboard traps
- [ ] Passes automated a11y (axe or Lighthouse) and a manual screen-reader spot check on key flows
- [ ] All states present: loading, empty, error, success
- [ ] Responsive from 320px up; no horizontal scroll; RTL-safe if the product supports RTL
- [ ] No console errors or warnings; no layout shift from images, fonts, or async content
- [ ] Bundle impact considered (no large library for a small task; route-level code splitting)
- [ ] Types clean; lint clean; component and interaction tests added for logic that can break
- [ ] Copy is real, not placeholder; error messages tell the user what to do next

## 8. Common anti-patterns

- `div` and `span` with `onClick` instead of `button` or `a`
- `useEffect` to compute or sync derived state (see `references/react-patterns.md`)
- Removing `outline` without a replacement focus style
- Fixed pixel heights that clip content when text grows or translates
- Layout built with magic margins and absolute positioning instead of flex or grid
- Storing server data in global client state and hand-rolling cache invalidation
- Disabling zoom (`user-scalable=no`) or using `100vh` where `100dvh` is needed on mobile
- Icon-only buttons without an accessible name
- Loading whole libraries (moment, lodash) for one function

## 9. Reference files (read when relevant)

- `references/accessibility.md`: WCAG 2.2 AA checklist, ARIA rules, focus management, testing
- `references/performance.md`: Core Web Vitals targets, fixes for LCP, INP, CLS, bundle and image strategy
- `references/react-patterns.md`: effects, state, hooks, React 19 features, Server Components boundaries, testing
- `references/css-and-layout.md`: tokens, grid and flex decisions, container queries, fluid type, RTL and i18n
