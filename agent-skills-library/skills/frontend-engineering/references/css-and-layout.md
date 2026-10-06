# CSS and layout reference

## Contents
1. Architecture and tokens
2. Layout decisions
3. Responsive strategy
4. Fluid type and spacing
5. Modern CSS features worth using
6. RTL and internationalization
7. Dark mode and theming
8. Common pitfalls

## 1. Architecture and tokens

- Define design tokens as CSS custom properties on `:root`: colors (semantic names such as `--color-surface`, `--color-text-muted`, `--color-accent`, `--color-danger`), spacing scale, radii, shadows, font stacks, type scale, z-index scale, durations, easing.
- Name tokens by role, not value (`--color-accent`, not `--color-blue-500` in components). Keep a primitive palette layer separate from the semantic layer.
- Use `@layer` (reset, base, components, utilities) to control cascade order without specificity wars.
- Keep specificity low: single class selectors; avoid IDs, deep descendant chains, and `!important` (only for utility overrides).
- If the project uses Tailwind, CSS modules, or CSS-in-JS, follow it and map tokens into its config rather than mixing systems.
- Set `box-sizing: border-box` globally; use a minimal reset; set `color-scheme`.
- Avoid magic numbers. If a value appears twice, it is a token.

## 2. Layout decisions

| Need | Use |
|---|---|
| One-dimensional row or column, alignment, distribution | Flexbox |
| Two-dimensional layout, aligned rows and columns | Grid |
| Responsive card grid without breakpoints | `grid-template-columns: repeat(auto-fit, minmax(min(100%, 16rem), 1fr))` |
| Align nested grid children to the parent tracks | `subgrid` |
| Page shell with sticky footer | `min-height: 100dvh; display: grid; grid-template-rows: auto 1fr auto` |
| Centering | `display: grid; place-items: center` |
| Spacing between siblings | `gap` (not margins on children) |
| Component adapts to its container, not viewport | Container queries (`container-type: inline-size` and `@container`) |
| Sticky header/sidebar | `position: sticky` with `top` and a defined containing block |
| Maintain proportions | `aspect-ratio` |
| Text truncation | `overflow: hidden; text-overflow: ellipsis; white-space: nowrap` (single line) or `line-clamp` |

Prefer intrinsic sizing (`min()`, `max()`, `clamp()`, `fit-content`, `minmax`) over fixed widths. Let content determine height; avoid fixed heights on anything containing text.

## 3. Responsive strategy

- Mobile-first: base styles for small screens; add `@media (min-width: ...)` for larger ones.
- Choose breakpoints where the content breaks, not by device names. Typical starting points: 40rem, 64rem, 80rem (use `em`/`rem` in media queries so they respect user font size).
- Use container queries for reusable components (cards, widgets) placed in different contexts.
- Use `dvh`/`svh`/`lvh` for full-height mobile layouts instead of `100vh`.
- Test 320px width, landscape phones, tablets, ultrawide, and browser zoom of 200%.
- Media features worth honoring: `prefers-reduced-motion`, `prefers-color-scheme`, `prefers-contrast`, `hover: hover` and `pointer: coarse` (do not rely on hover for essential UI).

## 4. Fluid type and spacing

```css
:root {
  --step-0: clamp(1rem, 0.95rem + 0.25vw, 1.125rem);
  --step-1: clamp(1.25rem, 1.15rem + 0.5vw, 1.5rem);
  --step-2: clamp(1.56rem, 1.35rem + 1vw, 2.25rem);
  --space-s: clamp(0.75rem, 0.7rem + 0.25vw, 1rem);
  --space-m: clamp(1rem, 0.9rem + 0.5vw, 1.5rem);
}
body { font: var(--step-0)/1.55 system-ui, sans-serif; }
```

- Keep `rem` as the base so user font settings scale everything; never set `html { font-size: 62.5% }` hacks that fight user settings without care.
- Body line length 45 to 75 characters: `max-width: 65ch` on prose.

## 5. Modern CSS features worth using

- Logical properties: `margin-inline`, `padding-block`, `inset-inline-start`, `border-inline-end`, `text-align: start`.
- `:is()`, `:where()` (zero specificity), `:has()` for parent or sibling-state styling, `:focus-visible`, `:focus-within`.
- Native nesting, `@layer`, `@container`, `@scope` (check support for the target browsers).
- `color-mix()`, `oklch()` for perceptually even palettes, `light-dark()` for theme values.
- `scroll-snap`, `scroll-padding`, `scroll-margin`, `overscroll-behavior`.
- `accent-color`, `field-sizing: content`, `text-wrap: balance` for headings and `pretty` for paragraphs.
- View Transitions API for page and state transitions (progressive enhancement).
- Feature-detect with `@supports`; always provide a working fallback.

## 6. RTL and internationalization

Design for direction and text expansion from the start; retrofitting is expensive.
- Set `<html lang="ar" dir="rtl">` (or per-section `dir`). Use `dir="auto"` for user-generated content of unknown direction.
- Use logical properties everywhere instead of `left`/`right`: `padding-inline-start`, `margin-inline-end`, `inset-inline`, `text-align: start`, `float: inline-start`, `border-start-start-radius`.
- Flexbox and grid flip automatically with `dir`; avoid hardcoded `row-reverse` hacks.
- Mirror directional icons (arrows, chevrons, back and forward, progress) with `[dir="rtl"] .icon-directional { transform: scaleX(-1) }`; do not mirror logos, clocks, media playback controls, or phone numbers.
- Numbers, Latin words, and code inside RTL text need `<bdi>` or `unicode-bidi: isolate` to avoid punctuation jumping.
- Use `Intl.NumberFormat`, `Intl.DateTimeFormat`, `Intl.RelativeTimeFormat`, `Intl.PluralRules` with the active locale; never format numbers or dates manually. Decide deliberately between Arabic-Indic and Western digits via the locale's `numberingSystem` (`ar-EG-u-nu-arab` vs `ar-EG-u-nu-latn`).
- Choose fonts that cover the script well (for Arabic: Noto Naskh Arabic, Noto Sans Arabic, IBM Plex Sans Arabic, Cairo, Tajawal, or similar); use slightly larger size and line height for Arabic; do not apply letter-spacing to Arabic (it breaks letter joining).
- Allow 30 to 40 percent text expansion in translations; no fixed-width buttons; no text baked into images.
- Externalize strings (i18next, FormatJS, Lingui, next-intl); use ICU MessageFormat for plurals and gender; never concatenate translated fragments.
- Test with pseudo-localization and an RTL locale in CI screenshots.

## 7. Dark mode and theming

```css
:root { color-scheme: light dark; --bg: #fff; --fg: #14161a; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --bg: #101318; --fg: #e8eaee; } }
:root[data-theme="dark"] { --bg: #101318; --fg: #e8eaee; }
```

- Redefine semantic tokens; do not invert images with filters. Re-check contrast in both themes.
- Avoid pure black (#000) backgrounds with pure white text; reduce saturation of accents on dark surfaces; express elevation with lighter surfaces rather than shadows.
- Offer a user toggle that overrides the system preference and persist it; apply it before first paint to avoid a flash.

## 8. Common pitfalls

- `100vw` causes horizontal scrollbars (it includes the scrollbar); use `100%` or `inline-size: 100%`.
- Flex children overflowing: add `min-width: 0` on the flex child that contains long text.
- Grid blowout: use `minmax(0, 1fr)` instead of `1fr` when content can be wide.
- z-index wars: define a scale (base 0, dropdown 100, sticky 200, overlay 300, modal 400, toast 500) and create stacking contexts intentionally.
- Animating layout properties triggers reflow; animate `transform` and `opacity`, and use `will-change` sparingly.
- Hover-only interactions fail on touch and keyboards; pair with `:focus-visible` and tap alternatives.
- Images without dimensions cause layout shift; always reserve space.
- Overusing `position: absolute` for layout; reserve it for overlays and decorations.
