---
name: typescript-engineering
description: Writes and reviews type-safe, maintainable TypeScript and modern JavaScript for Node.js, browsers, and libraries: strict tsconfig, type design (unions, generics, narrowing, branded types), runtime validation with Zod, async patterns, error handling, module structure, tooling (ESLint, Prettier or Biome, Vitest), and common pitfalls. Use whenever the user is writing or fixing TypeScript or JavaScript, configuring tsconfig or ESLint, fixing type errors, designing types or APIs, working with Node.js services or npm packages, or migrating JavaScript to TypeScript.
license: MIT
metadata:
  category: language
  version: "1.0"
---

# TypeScript Engineering

TypeScript's value is catching mistakes at compile time and documenting intent. Types are erased at runtime, so **validate untrusted data at boundaries** and let the compiler protect the inside.

Match the project's TypeScript version, module system, and lint rules first. Verify version-specific behavior: TypeScript is evolving (a native-compiler generation exists alongside classic tooling), so check the installed `typescript` version and its release notes before relying on newer flags.

## 1. Compiler configuration

Baseline `tsconfig.json` for a new project (adjust `target`, `module`, `lib` to runtime):
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "noImplicitReturns": true,
    "verbatimModuleSyntax": true,
    "isolatedModules": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "sourceMap": true,
    "outDir": "dist"
  },
  "include": ["src"]
}
```
- `strict: true` is non-negotiable for new code. `noUncheckedIndexedAccess` makes `array[i]` and `record[key]` possibly `undefined` (catches real bugs). Enable incrementally when migrating.
- Bundler-based apps (Vite, Next.js) use `"moduleResolution": "Bundler"`, `"module": "ESNext"`, `"noEmit": true` and let the bundler transpile; still run `tsc --noEmit` in CI.
- Use project references or a build tool (tsup, tsdown, unbuild, esbuild) for libraries; emit `.d.ts`; set `exports`, `types`, `files`, and `type` in `package.json`.
- Prefer ESM (`"type": "module"`), explicit file extensions where Node ESM requires them, and `import type` for type-only imports.

## 2. Type design

- **Model the domain with unions, not flags**:
```ts
type LoadState<T> =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "success"; data: T }
  | { status: "error"; error: Error };

function render(s: LoadState<User>) {
  switch (s.status) {
    case "idle": case "loading": return "…";
    case "success": return s.data.name;
    case "error": return s.error.message;
    default: { const _exhaustive: never = s; return _exhaustive; }   // compile error if a case is added
  }
}
```
- Prefer `unknown` over `any` for untrusted values, then narrow (`typeof`, `in`, `instanceof`, custom type guards, `zod.parse`). Treat every `any` and `as` assertion as a debt; use `satisfies` to check a value against a type without widening it.
- `interface` for object shapes that may be extended or implemented; `type` for unions, intersections, mapped and conditional types. Be consistent with the codebase.
- Use `readonly` and `as const` for immutable data; derive types from values:
```ts
const ROLES = ["admin", "editor", "viewer"] as const;
type Role = (typeof ROLES)[number];
```
- Prefer string-literal unions or `as const` objects over `enum` (simpler, tree-shakeable, no runtime surprises), unless the codebase uses enums or needs reverse mapping.
- **Branded types** prevent mixing ids: `type UserId = string & { readonly __brand: "UserId" }` with a validating constructor.
- Utility types: `Pick`, `Omit`, `Partial`, `Required`, `Readonly`, `Record`, `ReturnType`, `Awaited`, `Parameters`, `NonNullable`, `Extract`, `Exclude`. Don't build type gymnastics that nobody can read; simple types with a little duplication beat clever ones.
- Generics: constrain them (`<T extends { id: string }>`), let inference work, avoid unnecessary type parameters, and don't return `T` from functions that only conjure a value with `as T`.
- Function signatures: explicit parameter and return types on exported functions; inferred types for locals. Use overloads sparingly; prefer discriminated options objects.
- Optional (`x?: T`) vs `T | undefined` vs `T | null`: choose consistently; APIs generally use `undefined` for "absent" and `null` only when the wire format requires it. `exactOptionalPropertyTypes` distinguishes missing from `undefined`.
- Use `Result`-style returns or typed errors where callers must handle failure explicitly (or a library like neverthrow / Effect if the codebase adopts it), and exceptions for truly exceptional conditions.

## 3. Runtime validation at boundaries

Types don't validate JSON, environment variables, form data, or API responses. Validate with Zod, Valibot, ArkType, or similar, and infer types from the schema:
```ts
import { z } from "zod";

const CreateUser = z.object({
  email: z.string().email(),
  age: z.number().int().min(13).optional(),
  role: z.enum(["admin", "editor", "viewer"]).default("viewer"),
});
type CreateUser = z.infer<typeof CreateUser>;

const parsed = CreateUser.safeParse(req.body);
if (!parsed.success) return problem(422, parsed.error.flatten());
```
Validate: HTTP request bodies/params/query, environment variables at startup, external API responses, `JSON.parse` output, `localStorage`, message queue payloads, and CLI arguments. Check the installed schema library's version-specific API.

## 4. Async and errors

- Always `await` or return promises; enable lint rules `@typescript-eslint/no-floating-promises` and `no-misused-promises`. Handle rejections; never leave unhandled promise rejections.
- Run independent work in parallel with `Promise.all` (fail fast) or `Promise.allSettled` (collect results); bound concurrency for large batches (`p-limit`, `p-queue`) rather than firing thousands of requests.
- Timeouts and cancellation: `AbortController`/`AbortSignal.timeout(ms)` on `fetch` and long operations; pass signals through layers.
- `fetch` does not reject on HTTP error statuses: check `res.ok`, parse errors, and handle network failures.
- Custom errors: `class NotFoundError extends Error { constructor(msg: string, options?: ErrorOptions) { super(msg, options); this.name = "NotFoundError"; } }`; use `cause` to chain; in `catch (e)`, `e` is `unknown` (with `useUnknownInCatchVariables`); narrow before use.
- Avoid `try/catch` around large blocks; avoid swallowing errors; log with context at the boundary.
- In Node services: handle `SIGTERM`, close servers and pools gracefully; set server timeouts; don't block the event loop (offload CPU work to `worker_threads`/queues); use streams and backpressure for large data.

## 5. Modules, structure, and tooling

- Organize by feature/domain with clear public entry points (`index.ts` barrels sparingly: they can hurt tree-shaking and create cycles). Avoid circular imports (`madge`, `eslint-plugin-import`). Use path aliases consistently and configure both TS and the bundler.
- **Lint/format**: ESLint with `typescript-eslint` (type-aware "recommended-type-checked"/"strict" configs) plus Prettier, or Biome as a fast all-in-one; run in CI and pre-commit (lint-staged/husky/lefthook).
- **Tests**: Vitest or Jest with ts support; type tests (`expectTypeOf`, `tsd`) for library types; see `testing-strategy`.
- **Package management**: pnpm/npm/yarn per project; commit the lockfile; `npm ci` in CI; `engines`/`packageManager` fields; audit dependencies; prefer platform APIs (`fetch`, `URL`, `crypto.randomUUID`, `structuredClone`, `Intl`, `node:test`) over packages when adequate.
- **Runtime**: Node LTS (check the current LTS), Bun, or Deno as the project uses; Node can run TypeScript with type stripping in recent versions for simple cases, but keep a real type-check step.
- **Environment**: read `process.env` in one config module, validate with Zod, export typed config; never scatter `process.env.X!`.
- **Dependencies at boundaries**: wrap third-party SDKs behind small interfaces to ease testing and replacement.

## 6. Common pitfalls

| Pitfall | Better |
|---|---|
| `any` spreading through code | `unknown` + narrowing/validation; fix the source type |
| Non-null assertions `x!` and casts `as Foo` to silence errors | Narrow with checks, or restructure so the type is true |
| `==` and loose truthiness on `0`, `""`, `NaN` | `===`; explicit `null`/`undefined` checks; `??` instead of `||` for defaults |
| Mutating arguments or shared objects | Copy (`structuredClone`, spread), `readonly` types |
| `Array.sort()` mutating and comparing strings by default | Copy first (`toSorted` where available), pass a comparator for numbers |
| `for...in` on arrays; forgetting `await` in `forEach` | `for...of`; `for await`, `Promise.all(items.map(...))` |
| Floating point for money | Integer minor units or a decimal library |
| Dates with `new Date(string)` parsing quirks and local time zones | ISO 8601 UTC, `Intl.DateTimeFormat`, Temporal API when available, or date-fns/Luxon |
| `JSON.parse(...)` assumed typed | Validate the result |
| Large `enum`/barrel files inflating bundles | Literal unions; direct imports |
| Overly clever conditional/mapped types | Simpler explicit types; document the intent |
| Trusting `Object.keys` types (returns `string[]`) | Typed helpers or `Object.entries` with care |
| Prototype pollution via merging untrusted objects | Validate; use `Map`, `Object.create(null)`, safe merge utilities |

## 7. Migrating JavaScript to TypeScript

1. Add `tsconfig.json` with `allowJs`, `checkJs: false`, `strict: false`; get the build passing.
2. Convert files incrementally (leaf modules first); add types to boundaries and shared models; use `// @ts-expect-error` with explanation for known gaps rather than `any` blankets.
3. Turn on strict flags one at a time (`noImplicitAny`, `strictNullChecks`, then the rest); ratchet with CI to prevent regressions.
4. Replace runtime assumptions with validated schemas; remove `@ts-expect-error` as fixed.

## 8. Review checklist

- [ ] Compiles under strict settings; no unexplained `any`, `as`, or `!`
- [ ] Boundaries validated at runtime; types inferred from schemas
- [ ] Unions/exhaustive checks model states; no impossible states
- [ ] Promises awaited or handled; timeouts and cancellation on I/O
- [ ] Errors typed or wrapped with cause; no swallowed exceptions
- [ ] Lint, format, tests pass; lockfile committed; no accidental heavy dependencies
- [ ] Public API documented with TSDoc and covered by type/behavior tests
