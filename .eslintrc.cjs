/**
 * A small rule set that catches dead code and plain mistakes without restyling anything. Types are tsc's job
 * (`npm run typecheck`), so nothing here needs type information and the whole repo lints in seconds.
 */
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: { ecmaVersion: 2022, sourceType: 'module', ecmaFeatures: { jsx: true } },
  plugins: ['@typescript-eslint'],
  env: { es2022: true, node: true, browser: true },
  // Generated output and declaration files are not source.
  ignorePatterns: ['out/', 'release/', 'dist/', 'coverage/', 'node_modules/', '**/*.d.ts'],
  rules: {
    '@typescript-eslint/no-unused-vars': ['error', { args: 'none', ignoreRestSiblings: true, varsIgnorePattern: '^_' }],
    'no-debugger': 'error',
    'no-var': 'error',
    'no-dupe-keys': 'error',
    'no-duplicate-case': 'error',
    'no-unreachable': 'error'
  }
}
