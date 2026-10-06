# React patterns reference

Applies to React function components. Check the project's React version and framework (Next.js, Remix or React Router, Vite SPA) before using version-specific APIs.

## Contents
1. Effects: when not to use them
2. State design
3. Hooks rules and custom hooks
4. Rendering and memoization
5. React 19 features
6. Server Components boundaries
7. Suspense and error boundaries
8. Lists, keys, and refs
9. Testing

## 1. Effects: when not to use them

Effects are an escape hatch for synchronizing with **external systems** (network subscriptions, browser APIs, non-React widgets, analytics). If no external system is involved, you likely do not need one.

| Situation | Do this instead of an Effect |
|---|---|
| Filter or sort data for display | Compute during render (`const visible = items.filter(...)`) |
| Expensive derived value | `useMemo` after measuring, or the React Compiler if the project uses it |
| Reset state when a prop changes | Give the component a `key` for that prop, or restructure so state is derived |
| Adjust part of state on prop change | Compute during render, or store an id instead of the object |
| Respond to a user event (submit, click, buy) | Do the work in the event handler |
| Notify a parent of a change | Call the parent callback in the same event handler that changed the state |
| Chain of effects setting state for each other | Compute the final state in one handler or reducer |
| Fetching data | Framework loader, Server Component, or a query library; if hand-rolling, handle races with a cleanup flag or `AbortController` |
| Subscribing to an external store | `useSyncExternalStore` |

Legitimate Effect uses: connecting to a WebSocket, attaching a global event listener, integrating a map or chart library, focusing an element after mount, sending an analytics event tied to display (not to a click).

Every Effect must: declare all reactive dependencies honestly (never suppress the lint rule), clean up what it starts, and be safe to run twice (Strict Mode mounts, unmounts, and remounts in development to prove this).

## 2. State design

- Keep state minimal: store only what cannot be computed. No duplicated state; no mirroring props into state.
- Group related fields that change together into one object or use `useReducer`.
- Avoid contradictions: use a discriminated union for async status instead of separate `isLoading`, `isError`, `data` flags that can disagree.
- Store ids, not copies: `selectedId` instead of `selectedUser`, then derive the object.
- Colocate state with its consumers; lift only as far as the nearest common parent.
- Avoid deep nesting; normalize entity collections keyed by id when many places update them.
- Context is for values that rarely change (theme, locale, current user, dependency injection). For frequently changing shared state use a store with selectors so consumers re-render only for slices they read. Split contexts by concern and memoize provider values.
- Uncontrolled inputs with form submission are simpler and faster than controlling every keystroke; control only when you need live validation, formatting, or dependent fields.

## 3. Hooks rules and custom hooks

- Call hooks only at the top level of components or other hooks; never conditionally or in loops.
- Extract a custom hook when logic that uses hooks is reused or when it names a concept (`useDebouncedValue`, `useMediaQuery`, `useOnlineStatus`). A custom hook must be a function of React state, not a wrapper around lifecycle: avoid generic `useMount` style hooks.
- A custom hook shares logic, not state; each call has its own state.
- Return stable shapes; name booleans `isX`, `hasX`, `canX`.

## 4. Rendering and memoization

- Rendering is not the cost; unnecessary expensive rendering is. Measure with React DevTools Profiler first.
- Fix the structure before memoizing: move state down, pass `children` through, split components so frequently updating state does not sit above expensive subtrees.
- `memo`, `useMemo`, and `useCallback` are performance optimizations, never correctness tools. Code must work if they are removed.
- If the project enables the **React Compiler**, it memoizes automatically; write plain idiomatic code and avoid manual memoization unless profiling proves it needed. Follow the Rules of React (pure render, no mutation of props or state) so the compiler can optimize.
- Do not create components inside components (it resets state each render).
- Stable object and array props matter only when passed to memoized children or used as Effect dependencies.

## 5. React 19 features (when the project is on React 19+)

- **Actions**: pass a function to `<form action={fn}>`; React manages pending state and resets uncontrolled fields on success.
- `useActionState(action, initialState)`: returns `[state, formAction, isPending]` for form results and validation errors.
- `useFormStatus()` (from `react-dom`): pending state for a child of a form, for submit buttons.
- `useOptimistic(state)`: show the optimistic value while an async action runs; it reverts automatically on failure.
- `use(promise | context)`: read a promise (with Suspense) or context, and it may be called conditionally.
- `ref` as a prop on function components (no `forwardRef` needed); ref callbacks may return cleanup.
- Document metadata (`<title>`, `<meta>`, `<link>`) can be rendered inside components.
- `useTransition` supports async functions for non-blocking updates.

## 6. Server Components boundaries (frameworks such as Next.js App Router)

- Default to Server Components for data-heavy, non-interactive UI: they ship no JS and can read data directly.
- Add `"use client"` only at the leaf where interactivity, state, effects, or browser APIs are needed. Push the boundary down; the directive makes the file and everything it imports client code.
- Props crossing the boundary must be serializable (no functions, class instances, or Symbols); Server Actions can be passed as functions.
- Do not import server-only modules (DB clients, secrets) into client files; mark with `import "server-only"`.
- Treat Server Actions like public HTTP endpoints: authenticate, authorize, and validate input on every call.
- Colocate data fetching with the component that needs it and deduplicate through the framework cache; run independent fetches in parallel (`Promise.all`) to avoid waterfalls.

## 7. Suspense and error boundaries

- Wrap async subtrees in `<Suspense fallback={<Skeleton />}>` at meaningful granularity (a card, a panel), not the whole page.
- Wrap likely-failing regions in error boundaries (`react-error-boundary` or the framework's `error.tsx`) with a retry action; log errors to monitoring.
- Error boundaries do not catch errors in event handlers, async code outside Suspense, or SSR; handle those explicitly.

## 8. Lists, keys, and refs

- `key` must be stable and unique among siblings: database ids, not indexes, when items can reorder, insert, or delete. Changing `key` deliberately resets a component's state.
- Refs are for imperative escapes (focus, scroll, measure, media control). Never read or write `ref.current` during render.
- Avoid `dangerouslySetInnerHTML`; if unavoidable, sanitize with DOMPurify and a strict allowlist.

## 9. Testing

- Test behavior the user can observe, not implementation details. Use Testing Library with `userEvent`; query by role, label, and text (`getByRole`, `getByLabelText`); avoid test ids unless nothing accessible exists.
- Mock the network boundary with MSW, not individual `fetch` calls or hooks.
- Use `findBy*` or `waitFor` for async UI; never arbitrary sleeps.
- Cover: happy path, validation errors, loading and error states, keyboard interactions for custom widgets.
- Add end-to-end tests (Playwright) for a few critical journeys (sign in, checkout, core create-edit-delete).
- Visual regression only for stable design-system components, and review diffs carefully.
