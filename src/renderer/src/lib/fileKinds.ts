import { File, FileArchive, FileCode, FileCog, FileImage, FileJson, FileSpreadsheet, FileTerminal, FileText, type LucideIcon } from 'lucide-react'

const LANGUAGES: Record<string, string> = {
  ts: 'TypeScript', tsx: 'TypeScript React', mts: 'TypeScript', cts: 'TypeScript', js: 'JavaScript', jsx: 'JavaScript React', mjs: 'JavaScript', cjs: 'JavaScript',
  json: 'JSON', jsonc: 'JSON with comments', ndjson: 'JSON lines', md: 'Markdown', mdx: 'MDX', css: 'CSS', scss: 'SCSS', less: 'Less', html: 'HTML', htm: 'HTML',
  xml: 'XML', svg: 'SVG', vue: 'Vue', svelte: 'Svelte', py: 'Python', rs: 'Rust', go: 'Go', java: 'Java', kt: 'Kotlin', cs: 'C#', c: 'C', h: 'C header',
  cpp: 'C++', cc: 'C++', hpp: 'C++ header', swift: 'Swift', php: 'PHP', rb: 'Ruby', sh: 'Shell', bash: 'Shell', zsh: 'Shell', ps1: 'PowerShell', bat: 'Batch', cmd: 'Batch',
  yml: 'YAML', yaml: 'YAML', toml: 'TOML', ini: 'INI', env: 'Environment', sql: 'SQL', graphql: 'GraphQL', csv: 'CSV', tsv: 'TSV', txt: 'Plain text', log: 'Log', lock: 'Lockfile'
}

const NAMED: Record<string, string> = { Dockerfile: 'Dockerfile', Makefile: 'Makefile', LICENSE: 'License', '.gitignore': 'Git ignore', '.env': 'Environment' }

const ICONS: Array<[RegExp, LucideIcon]> = [
  [/\.(png|jpe?g|gif|webp|svg|ico|bmp|avif)$/i, FileImage],
  [/\.(zip|gz|tgz|tar|7z|rar|bz2|xz)$/i, FileArchive],
  [/\.(json|jsonc|ndjson)$/i, FileJson],
  [/\.(ya?ml|toml|ini|env|conf|cfg|lock)$|^\.(env|gitignore|gitattributes|editorconfig|npmrc|prettierrc|eslintrc)/i, FileCog],
  [/\.(csv|tsv)$/i, FileSpreadsheet],
  [/\.(sh|bash|zsh|ps1|bat|cmd)$/i, FileTerminal],
  [/\.(md|mdx|txt|rst|log)$|^(LICENSE|README|CHANGELOG|NOTICE)$/i, FileText],
  [/\.(tsx?|jsx?|mjs|cjs|mts|cts|py|rs|go|java|kt|cs|c|h|cpp|cc|hpp|swift|php|rb|css|scss|less|html?|xml|vue|svelte|sql|graphql)$|^(Dockerfile|Makefile)$/i, FileCode]
]

const nameOf = (path: string): string => path.split(/[\\/]/).pop() ?? path

export function languageName(path: string): string {
  const name = nameOf(path)
  if (NAMED[name]) return NAMED[name]
  const dot = name.lastIndexOf('.')
  return dot < 0 ? 'Plain text' : LANGUAGES[name.slice(dot + 1).toLowerCase()] ?? 'Plain text'
}

export function iconFor(path: string): LucideIcon {
  const name = nameOf(path)
  return ICONS.find(([pattern]) => pattern.test(name))?.[1] ?? File
}

export const isMarkdownPath = (path: string): boolean => /\.(md|mdx|markdown)$/i.test(path)
export const isSvgPath = (path: string): boolean => /\.svg$/i.test(path)
