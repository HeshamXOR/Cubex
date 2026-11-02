# Project rules

- Every module in `src/` starts with the exact line `// SPDX-License-Identifier: MIT` as its first line.
- Every module in `src/` has a test file `test/<module>.test.mjs` written with `node:test`.
- Use named exports only. Never use `export default`.
- Run the whole suite with `node --test` before you say you are done.
