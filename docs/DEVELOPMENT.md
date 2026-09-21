# Development

## Prerequisites

- **Node.js 20+** and npm.
- Native modules (`better-sqlite3`) are rebuilt for Electron's ABI by the `postinstall` hook
  (`electron-builder install-app-deps`). On Windows this needs the standard build toolchain that
  ships with recent Node; if a rebuild fails, run `npx electron-rebuild -f -w better-sqlite3`.
- An SSD is recommended for `node_modules` and local model files.

## Scripts

```bash
npm install        # deps + native rebuild for Electron
npm run dev        # launch the app (electron-vite dev, HMR renderer)
npm test           # Vitest suite — no credentials or GPU needed
npm run test:watch
npm run typecheck  # strict tsc for node + web projects
npm run build      # compile main + preload + renderer to out/
npm run dist:win   # NSIS installer  → release/
npm run dist:linux # AppImage + .deb → release/
npm run dist:mac   # dmg            → release/
```

Zero-setup dev: add the **Mock** provider (no key, offline) and chat — it exercises the full
streaming / retry / tool pipeline.

## Project layout

```
packages/
  core/          pure TypeScript — types, gateway, retry, streaming, errors, providers
  local/         hardware, estimation, compatibility, benchmarks, runtimes, catalog
src/
  main/          Electron main: ipc, ProviderManager, ChatService, LocalService, db, credentials
  preload/       window.cubex bridge (contextIsolation)
  renderer/      React UI (Vite): components, views, state (zustand), theme, status
  shared/        ipc.ts contract + settings types
docs/            these documents
resources/       app icon
```

## Path aliases

`@core/*`, `@local/*`, `@shared/*`, `@main/*`, `@renderer/*` are defined in `tsconfig.json` and
mirrored in `electron.vite.config.ts` and `vitest.config.ts`. The renderer imports only from
`@core/*` (types + pure helpers) and `@shared` — never Electron/Node code.

## Type projects

- `tsconfig.node.json` — core, local, main, preload, shared, tests (Node/Electron context).
- `tsconfig.web.json` — renderer + shared + core types (DOM context).

`npm run typecheck` runs both. Both must be clean before a PR.

## Browser-only renderer preview

For fast UI iteration without launching Electron, `vite.renderer.config.ts` serves just the
renderer (port 5199). When Electron isn't present, `src/renderer/src/lib/api.ts` swaps `window.cubex`
for a **browser stub** that returns empty data (clearly labeled), so the UI renders standalone.

## Conventions

- Strict TypeScript (`noUncheckedIndexedAccess`); guard array access.
- Keep `packages/core` free of Electron/DOM imports.
- New behavior ships with tests; see [TESTING.md](TESTING.md).
- Never log or display secrets — route sensitive fields through the redaction helpers.
