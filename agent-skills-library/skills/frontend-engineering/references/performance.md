# Frontend performance reference

## Contents
1. Targets and measurement
2. LCP fixes
3. INP fixes
4. CLS fixes
5. JavaScript and bundle strategy
6. Images, fonts, media
7. Networking and caching
8. Rendering strategy
9. Performance review checklist

## 1. Targets and measurement

Core Web Vitals, judged at the **75th percentile of real-user (field) data**:

| Metric | Good | Needs improvement | Poor |
|---|---|---|---|
| LCP (Largest Contentful Paint) | 2.5 s or less | up to 4.0 s | over 4.0 s |
| INP (Interaction to Next Paint) | 200 ms or less | up to 500 ms | over 500 ms |
| CLS (Cumulative Layout Shift) | 0.1 or less | up to 0.25 | over 0.25 |

INP replaced First Input Delay in March 2024 and reports the slowest interactions across the whole visit. Treat these thresholds as of the last verified date; re-check web.dev if the numbers matter for a decision.

Measure before optimizing:
- **Field**: CrUX / PageSpeed Insights field data, `web-vitals` library sent to analytics (RUM).
- **Lab**: Lighthouse, Chrome DevTools Performance panel (with CPU 4x slowdown and Slow 4G throttling), WebPageTest.
- Optimize the metric that fails at p75, on the worst page template, on mid-range mobile hardware. Lab scores are a proxy, not the goal.

## 2. LCP fixes (loading)

Break LCP into parts: time to first byte, resource load delay, resource load time, element render delay. Fix the largest part first.
- Server response: cache at the CDN, cut redundant server work, stream HTML, avoid redirect chains.
- The LCP element (usually a hero image or heading) must be discoverable in the initial HTML. Do not lazy-load it and do not inject it with JavaScript.
- `<img fetchpriority="high">` or a `<link rel="preload" as="image">` for the hero image; `loading="lazy"` only below the fold.
- Serve properly sized, modern formats (AVIF or WebP with fallback) with `srcset` and `sizes`.
- Avoid render-blocking CSS and JS: inline critical CSS, `defer` scripts, split large stylesheets by route.
- Web fonts: see section 6.

## 3. INP fixes (responsiveness)

Interaction = input delay + processing time + presentation delay.
- Keep main-thread tasks under 50 ms. Break long tasks: yield with `scheduler.yield()` (feature-detect) or `setTimeout(0)`; move heavy computation to a Web Worker.
- Keep event handlers tiny: update state, then defer heavy work. Do not run synchronous layout reads after writes (layout thrashing).
- Reduce the amount of DOM re-rendered per interaction: colocate state, virtualize long lists (TanStack Virtual, react-window), avoid rendering hidden tabs and offscreen content, use `content-visibility: auto`.
- React specifics: `useTransition` and `useDeferredValue` for non-urgent updates such as filtering big lists; avoid giant context values that re-render everything; profile with React DevTools Profiler before adding `memo`.
- Third-party scripts (analytics, chat, tag managers) are the most common hidden cause: load after interaction or idle, use facades for embeds, audit regularly.

## 4. CLS fixes (visual stability)

- Reserve space for every image, video, iframe, and ad: `width` and `height` attributes or `aspect-ratio`.
- Fonts: use `font-display: swap` or `optional`, preload the primary font, and use `size-adjust` and metric overrides on fallback faces to reduce reflow.
- Do not insert content above existing content after load (banners, consent bars): reserve space or overlay.
- Animate `transform` and `opacity`, not `top`, `left`, `width`, or `height`.
- Skeletons must match the final layout dimensions.

## 5. JavaScript and bundle strategy

- Set a **performance budget** (for example under 170 KB compressed JS for the initial route on content sites; tune per product) and fail CI when exceeded (`size-limit`, `bundlesize`, Lighthouse CI).
- Analyze bundles (`vite-bundle-visualizer`, `webpack-bundle-analyzer`, `next build` output) before and after adding dependencies.
- Code-split by route and by heavy feature (editors, charts, maps) with dynamic `import()`.
- Prefer small, tree-shakeable libraries (`date-fns` or native `Intl` over `moment`; per-function imports). Use `Intl.DateTimeFormat`, `Intl.NumberFormat`, `structuredClone`, `fetch`, `URL`, `AbortController` natively.
- Remove dead code and unused polyfills; target modern browsers via browserslist.
- Ship less JS by default: server rendering, islands, or Server Components for content that needs no interactivity.
- Avoid huge JSON blobs in the initial HTML payload and unbounded client-side lists.

## 6. Images, fonts, media

- Images: right dimensions for the rendered size times device pixel ratio (max 2x to 3x); AVIF or WebP; `srcset`/`sizes`; `decoding="async"`; a CDN with on-the-fly resizing; SVG for icons and logos; avoid GIF (use MP4 or WebM).
- Fonts: self-host, subset to needed scripts (for Arabic, Latin, etc.), use WOFF2, limit to 2 families and few weights, use variable fonts when several weights are needed, preload only the critical face.
- Video: `preload="none"` or `metadata`, poster image, lazy-load below the fold, use facades for YouTube embeds.

## 7. Networking and caching

- Hashed static assets: `Cache-Control: public, max-age=31536000, immutable`.
- HTML: short or revalidated (`no-cache` with ETag) or CDN-cached with purge on deploy.
- Use HTTP/2 or HTTP/3, Brotli compression, `preconnect` to critical third-party origins, `dns-prefetch` for others.
- API: batch requests, avoid waterfalls, cache with `stale-while-revalidate` semantics in the client cache, paginate.
- Service workers only when offline support is a real requirement; they add cache-invalidation complexity.

## 8. Rendering strategy

| Strategy | Use when | Trade-off |
|---|---|---|
| Static generation (SSG) | Content rarely changes (docs, marketing, blogs) | Fastest LCP; rebuild or ISR needed for updates |
| Server-side rendering (SSR) with streaming | Personalized or frequently changing content, SEO needed | Higher TTFB; needs server capacity |
| Client-side rendering (SPA) | Authenticated app behind login, heavy interactivity, no SEO need | Slower first load; ship less JS and prefetch |
| Islands / partial hydration | Mostly static pages with pockets of interactivity | Framework support required |

## 9. Performance review checklist

- [ ] LCP element identified, in initial HTML, prioritized
- [ ] No long tasks over 50 ms on primary interactions
- [ ] Images sized with dimensions, modern format, lazy below the fold
- [ ] Fonts subset, preloaded, with fallback metrics
- [ ] Third-party scripts audited and deferred
- [ ] Bundle diff reviewed for every new dependency
- [ ] Lists over ~100 rows virtualized or paginated
- [ ] Real-user monitoring in place for LCP, INP, CLS
