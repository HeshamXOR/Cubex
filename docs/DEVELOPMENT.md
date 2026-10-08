# Development

## Prerequisites

- Node.js 20 or 22 and npm. CI runs on Node 22.
- A C++ toolchain (Python 3 and the Visual Studio Build Tools with the C++ workload on Windows) only if the native module has no prebuilt binary for your Node version. `better-sqlite3` 11 ships prebuilt binaries for Node 18 to 23, so Node 24 and newer compile it during `npm install`. It is then rebuilt for Electron's ABI by the `postinstall` script (`electron-builder install-app-deps`). If that step fails, run `npx electron-rebuild -f -w better-sqlite3` and read its error.

Windows is the platform Cubex is developed and tested on. The shell tool, path handling and the installer all assume it. Linux and macOS builds are configured in `electron-builder.yml` but have not been verified.

## Scripts

```bash
npm install          # dependencies, then the native rebuild for Electron
npm run dev          # start the app with hot reload (electron-vite dev)
npm run dev:web      # renderer only, in a browser at http://localhost:5199
npm run build        # compile main, preload and renderer to out/
npm start            # run the built app from out/ (electron-vite preview)

npm test             # run the Vitest suite once
npm run test:watch   # re-run on change
npm run test:cov     # coverage (needs @vitest/coverage-v8, see TESTING.md)
npm run lint         # ESLint over .ts and .tsx
npm run typecheck    # both TypeScript projects (typecheck:node, typecheck:web)

npm run dist:win     # Windows installer (NSIS) in release/
npm run dist:linux   # AppImage and deb
npm run dist:mac     # dmg for x64 and arm64
npm run dist         # installer for the current platform

node scripts/release.mjs check v0.2.0   # is the repository ready to release this version?
node scripts/dev-update-feed.mjs        # a release feed on this computer, to try updates (UPDATES.md)
```

For a first run without any account, add the **Offline demo** provider from the Providers screen. It needs no key and exercises the streaming, retry and tool pipeline against simulated replies.

`npm run dev:web` serves the renderer in a plain browser, where it uses a stub in place of the Electron bridge. Add `?seed=1` to the URL for sample data. The flags and their limits are described in [TESTING.md](TESTING.md#visual-checks). Use Electron (`npm run dev`) to check anything that touches persistence, tools, processes or the IPC bridge.

## Project layout

```text
packages/
  core/                 provider-agnostic TypeScript: types, gateway, retry, streaming, errors,
                        redaction, model registry, provider adapters, subagent tool
  local/                hardware profiling, memory and speed estimates, compatibility, benchmarks,
                        download queue, local runtimes, model catalog
src/
  main/                 Electron main process: IPC, ChatService, tools, storage, MCP,
                        diagnostics, notifications, background tasks
  preload/              the window.cubex bridge
  renderer/             React UI: components, views, state (zustand), theme
  shared/               IPC contract, settings types, pure helpers used by both processes
agent-skills-library/   bundled skills, read directly in development and from the packaged app
docs/                   these documents
resources/              app icons
scripts/                release and update tooling (release.mjs, dev-update-feed.mjs) and manual QA scripts
```

[ARCHITECTURE.md](ARCHITECTURE.md) explains how the layers fit together and where each kind of extension goes.

## Path aliases and type projects

`@core/*`, `@local/*`, `@shared/*`, `@main/*` and `@renderer/*` are defined in `tsconfig.json`. `electron.vite.config.ts` and `vite.web.config.ts` mirror all five. `vitest.config.ts` defines `@core`, `@local` and `@shared`, so tests import main-process and renderer code with relative paths.

- `tsconfig.node.json` covers `packages/core`, `packages/local`, `src/main`, `src/preload` and `src/shared`, plus the Vite and Vitest configs.
- `tsconfig.web.json` covers `src/renderer` and `src/shared`, plus the core types and builders, in a DOM context.

`npm run typecheck` runs both, and both must be clean before a pull request. The compiler options are strict, with `noUncheckedIndexedAccess`, so guard array and record access.

`npm run lint` runs ESLint with a deliberately small rule set (`.eslintrc.cjs`): unused variables, `debugger`, `var`, duplicate keys and cases, and unreachable code. It does not restyle anything, and types are left to `tsc`.

## Environment variables

Cubex does not load `.env` files. Set these in the environment that starts the app.

| Variable | Effect |
|---|---|
| `CUBEX_DATA_DIR` | Use this folder instead of the default data folder. Point it at a scratch folder when testing so your real conversations and settings are untouched. |
| `CUBEX_MOCK_LOCAL=1` | Register the mock local runtime (see [LOCAL_MODELS.md](LOCAL_MODELS.md)). |
| `CUBEX_OPENAI_API_KEY`, `CUBEX_ANTHROPIC_API_KEY`, `CUBEX_GEMINI_API_KEY`, `CUBEX_OPENAI_COMPAT_API_KEY` | A key for a provider of that kind when no key is stored for it. Meant for development. A key saved in the app wins. |
| `CUBEX_UPDATE_FEED` | Read releases from this address instead of GitHub, to try the update window without publishing. Only an `http` or `https` address on `127.0.0.1`, `localhost` or `[::1]` is taken, and anything else is ignored. See [UPDATES.md](UPDATES.md#trying-it-without-publishing). |

The in-app secure store is the normal way to keep a key. See [SECURITY.md](SECURITY.md).

## Where data lives

Everything Cubex writes is under one folder, `cubex-data` inside Electron's user data folder (on Windows, `%APPDATA%\Cubex`). The **About** group in Settings shows the exact paths and has an Open button for each. `CUBEX_DATA_DIR` overrides the location.

| Path | Contents |
|---|---|
| `cubex.db` | SQLite (WAL): providers, conversations and messages, presets, usage records, logs, benchmark results |
| `config.json` | Settings, with no secrets |
| `credentials.enc.json` | Secrets, encrypted with the operating system's credential store |
| `plans/` | Saved Markdown plans and their review receipts |
| `command-output/` | Saved output of shell commands, one folder per task |
| `session-changes/` | The original copies of files a task changed, for review and undo |
| `permission-rules.json` | "Always allow" rules, per project |
| `logs/` | One redacted JSON Lines file per day |

## Adding a feature

Four folders are scanned with `import.meta.glob`, so a feature adds a file and edits no central list. [ARCHITECTURE.md](ARCHITECTURE.md#extension-points) describes each one.

1. Main-process handlers: a module in `src/main/ipcModules/` that exports `register(ctx)`.
2. The contract: add the channel to `IPC` and the method to `CubexAPI` in `src/shared/ipc.ts`, and bridge it in `src/preload/index.ts`.
3. UI: a settings section in `src/renderer/src/views/settings/sections/`, which names the page of Settings it belongs to, or a right-hand panel tab in `src/renderer/src/components/panelTabs/`.
4. Preview data: a file in `src/renderer/src/lib/seeds/` that exports `seed`, so the browser preview can show the feature.

`src/main/ipcContract.test.ts` fails when a channel is missing a handler or a bridge, so step 2 cannot be forgotten silently.

## Runtime behavior to keep intact

These properties are easy to break while adding a provider, a tool or an event.

- The main process runs tools and emits ordered events. Each stream carries sequence numbers and each model request has an iteration event. The renderer updates a tool block by call id and ignores older or replayed events, including those from a stopped or retired stream.
- A model request is retried only before anything has streamed. Once text, reasoning or tool-call data reaches the user, an error ends the turn and the partial response is kept.
- Messages are stored in full. Display metadata (tool rows, diffs, reasoning) is stored beside them, capped at 1 MiB and 128 blocks per message, and is never replayed to a provider as tool-call protocol.
- Composer text and unsent attachments belong to a task and live in memory. They survive switching tabs, not a restart. Composer text is limited to 500,000 characters.
- File checkpoints are kept in memory and cover only the file tools. A shell command that edits files is not tracked. The review panel keeps its own copies on disk, also for file-tool edits only.
- `run_command` is a bounded foreground command (60 seconds by default, 5 minutes at most). A command that must keep running is started with `background: true` and managed through the task tools.
- Plans are immutable Markdown files with separate review receipts. Saved command output is stored under a hash of the task id with generated ids, up to 2 MiB per command and 50 outputs per task. Both are local and unencrypted.
- Cubex permissions never override operating-system access controls. An access-denied result is reported as such and is not retried by switching shells.

## Packaging

```bash
npm run dist:win
```

builds the Windows installer into `release/` as `Cubex-Setup-<version>.exe` (NSIS, per-user by default, with a choice of install folder). The installer is unsigned, so Windows SmartScreen shows a warning on first run: choose **More info**, then **Run anyway**.

CI does not build installers. A release does: pushing a tag such as `v0.2.0` runs `.github/workflows/release.yml`, which builds the installer and publishes it as a GitHub release. [RELEASING.md](RELEASING.md) has the steps. The installer must be called `Cubex-Setup-<version>.exe`, because that is the name the updater looks for ([UPDATES.md](UPDATES.md)). The Linux (AppImage, deb) and macOS (dmg) targets are configured and unverified.

Native modules are unpacked from the app archive (`asarUnpack: **/*.node`). The bundled skills library is packaged from `agent-skills-library/` and read from the archive at run time.

## Conventions

- Keep `packages/core` free of Electron and DOM imports. The renderer reaches the main process only through `window.cubex`, and takes types and a few pure helpers from `@core` and `@shared`.
- New behavior ships with tests. See [TESTING.md](TESTING.md).
- Never log or display secrets. Route sensitive fields through the redaction helpers in `packages/core/src/redaction`.
- Treat everything the renderer sends over IPC as untrusted: validate ids, paths and sizes in the handler.
