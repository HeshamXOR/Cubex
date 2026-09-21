# Contributing to Cubex

Thanks for your interest in improving Cubex! This project is a provider-agnostic desktop AI
harness, and contributions of all sizes are welcome.

## Getting started

```bash
npm install      # installs deps + rebuilds native modules for Electron
npm run dev      # launch the app
npm test         # run the test suite (no credentials or GPU needed)
npm run typecheck
```

The **Mock provider** (built in, no API key) lets you develop and test the entire streaming /
retry / tool pipeline offline.

## Ground rules

- **Type-safety first.** The codebase is strict TypeScript with `noUncheckedIndexedAccess`. Run
  `npm run typecheck` before opening a PR.
- **Keep the core pure.** `packages/core` must not import Electron or DOM APIs — that's what keeps
  it testable with mocks. Node/Electron code lives in `src/main`; UI in `src/renderer`.
- **Add tests.** New adapters, gateway behavior, or estimation logic should come with Vitest
  coverage. See [docs/TESTING.md](docs/TESTING.md).
- **Never present estimates as guarantees.** Performance numbers are ranges labeled
  Theoretical / Runtime / Measured. Keep it that way.
- **Official APIs only.** No web scraping, no subscription/rate-limit bypass, no reverse-engineered
  private endpoints. See [docs/SECURITY.md](docs/SECURITY.md).
- **Never log or display secrets.** Route new sensitive fields through the redaction helpers.

## Adding a provider

See [docs/PROVIDERS.md](docs/PROVIDERS.md). In short: implement the `AIProvider` interface (or
extend `BaseProvider`), register it in `packages/core/src/providers/factory.ts`, and add
translation + streaming tests.

## Commit & PR

- Branch from `main`; keep PRs focused.
- Describe what changed, what you tested, and any known limitations.
- CI runs typecheck + tests on Linux/macOS/Windows and must pass.

## Code of Conduct

Be respectful and constructive. Harassment or discrimination of any kind is not tolerated.
