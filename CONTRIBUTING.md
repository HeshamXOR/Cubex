# Contributing to Cubex

Thank you for your interest in improving Cubex. It is a desktop harness that lets one app work with many model providers and local runtimes, and contributions of any size are welcome.

## Getting started

You need Node.js 20 or 22 and npm. See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) for the full setup.

```bash
npm install        # dependencies, then a native rebuild for Electron
npm run dev        # start the app
npm test           # run the test suite (no credentials or GPU needed)
npm run typecheck
npm run lint
```

The built-in **Offline demo** provider needs no key, so you can work on the streaming, retry and tool pipeline without an account. `npm run dev:web` serves the renderer in a browser with sample data for quick interface work (see [docs/TESTING.md](docs/TESTING.md#visual-checks)).

Cubex is developed and tested on Windows. The Linux and macOS builds are configured but not verified, and help checking them is welcome.

## Ground rules

- **Type safety.** The code is strict TypeScript with `noUncheckedIndexedAccess`. Run `npm run typecheck` before you open a pull request.
- **Keep the core pure.** `packages/core` must not import Electron or DOM APIs. That is what keeps it testable with mocks. Node and Electron code lives in `src/main`, and the interface in `src/renderer`.
- **Add tests.** New adapters, gateway behavior, tools and estimation logic come with Vitest coverage. See [docs/TESTING.md](docs/TESTING.md).
- **Do not present estimates as guarantees.** Memory and speed figures are ranges with a stated basis. Keep it that way.
- **Provider adapters use official APIs.** No scraping of web interfaces, no getting around rate limits or subscription terms, and no private endpoints. See [docs/SECURITY.md](docs/SECURITY.md).
- **Never log or display secrets.** Route new sensitive fields through the redaction helpers.
- **Treat renderer input as untrusted.** Validate ids, paths and sizes in the main-process handler.

## Adding a provider

See [docs/PROVIDERS.md](docs/PROVIDERS.md). In short: implement the `AIProvider` interface (or extend `BaseProvider`), register the kind in `packages/core/src/providers/factory.ts`, and add translation and streaming tests. If the service speaks the OpenAI Chat Completions format, a preset in `src/shared/providerPresets.ts` is usually all it needs.

## Adding a feature

New IPC handlers, settings sections, panel tabs and preview sample data are each a new file in a scanned folder, not an edit to a central list. [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#extension-points) lists the folders. A new IPC channel also needs an entry in `src/shared/ipc.ts` and a bridge in `src/preload/index.ts`, and `src/main/ipcContract.test.ts` checks both.

## Pull requests

- Branch from `main` and keep each pull request focused.
- Run `npm run lint`, `npm run typecheck`, `npm test` and `npm run build` before you push. CI runs the same four commands on Windows for every push and pull request to `main`, and they must pass.
- Describe what changed, how you tested it, and any known limitations.
- The repository normalizes line endings to LF (`.gitattributes`), so you do not need to convert files by hand.
- Releases are cut by a maintainer, from a tag on `main`. You do not need to bump the version or edit `CHANGELOG.md`, but a line there about a change people will notice is welcome. [docs/RELEASING.md](docs/RELEASING.md) explains the process.

## Security issues

Please do not open a public issue for a vulnerability. [docs/SECURITY.md](docs/SECURITY.md) explains how to report one privately.

## Code of conduct

Be respectful and constructive. Harassment and discrimination of any kind are not tolerated.
