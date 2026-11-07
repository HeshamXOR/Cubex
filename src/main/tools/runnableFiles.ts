/**
 * Files that run code the next time someone builds, tests, installs or pushes: a package's scripts, a Makefile, a test
 * runner's config, a CI workflow. Changing one is how a harmless-looking command ("npm test") comes to do something else,
 * so an edit to one is never approved by a mode or a rule, and a saved rule stops covering commands once one has changed.
 *
 * Ordinary source files also run under a test command, so this narrows the gap and does not close it. Only an OS sandbox
 * does that. The list is what a person would not expect to be asked about having run.
 */
const NAMES = new RegExp('^(?:' + [
  // JavaScript
  'package\\.json', '\\.npmrc', '\\.yarnrc(?:\\.yml)?', '\\.pnpmfile\\.c?js',
  // Python
  'pyproject\\.toml', 'setup\\.py', 'setup\\.cfg', 'tox\\.ini', 'noxfile\\.py', 'conftest\\.py', 'pytest\\.ini',
  // Other builds
  'makefile', 'gnumakefile', 'justfile', 'taskfile\\.ya?ml', 'rakefile', 'gemfile', 'cargo\\.toml', 'build\\.rs',
  'build\\.gradle(?:\\.kts)?', 'settings\\.gradle(?:\\.kts)?', 'gradlew(?:\\.bat)?', 'pom\\.xml', 'build\\.ps1', 'build\\.sh',
  // Hooks and environments
  '\\.envrc', '\\.pre-commit-config\\.ya?ml', '\\.?lefthook\\.ya?ml', '\\.gitlab-ci\\.yml', '\\.gitmodules', '\\.gitattributes',
  // Configs that are programs
  '(?:vitest|jest|vite|webpack|rollup|esbuild|babel|eslint|prettier|next|nuxt|svelte|astro|tailwind|postcss|playwright|cypress|karma|electron\\.vite|electron-builder)\\.config\\.[cm]?[jt]sx?',
  '\\.(?:eslintrc|babelrc|prettierrc|mocharc)\\.[cm]?js'
].join('|') + ')$', 'i')

/** Folders where everything is a program something else starts. */
const FOLDERS = /(?:^|[\\/])(?:\.github[\\/]workflows|\.github[\\/]actions|\.circleci|\.gitlab|\.devcontainer|\.cargo|\.mvn)[\\/]/i

/** Whether writing to this path can change what a later build, test, install or CI run executes. */
export function isRunnableFile(path: string): boolean {
  if (typeof path !== 'string' || !path) return false
  if (FOLDERS.test(path)) return true
  const name = path.split(/[\\/]/).pop() ?? ''
  return NAMES.test(name)
}

/** The file's name, for telling the person which one it was. */
export function runnableFileName(path: string): string {
  return path.split(/[\\/]/).pop() || path
}
