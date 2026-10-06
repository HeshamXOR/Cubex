/** Browser-safe upload rules shared by the composer and request normalization. */
export const TEXT_ATTACHMENT_MAX_BYTES = 256 * 1024
export const TEXT_ATTACHMENT_TOTAL_MAX_BYTES = 1024 * 1024
export const TEXT_ATTACHMENT_MAX_FILES = 8
/** Provider per-image ceiling (Anthropic: 5 MB). Images stay in history, so an oversized one would fail every later turn. */
export const IMAGE_ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024
export const IMAGE_ATTACHMENT_MAX_COUNT = 20

export const TEXT_ATTACHMENT_EXTENSIONS = [
  '.txt', '.md', '.mdx', '.markdown', '.rst', '.adoc', '.org', '.tex', '.csv', '.tsv', '.log',
  '.json', '.jsonc', '.jsonl', '.ipynb', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.xml',
  '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.html', '.htm', '.css', '.scss', '.sass', '.less',
  '.py', '.pyi', '.rb', '.go', '.rs', '.java', '.kt', '.kts', '.swift', '.c', '.h', '.cc', '.cpp',
  '.cxx', '.hpp', '.cs', '.fs', '.fsx', '.vb', '.php', '.sh', '.bash', '.zsh', '.fish', '.ps1',
  '.psm1', '.psd1', '.bat', '.cmd', '.sql', '.graphql', '.gql', '.proto', '.vue', '.svelte',
  '.astro', '.lock', '.properties', '.env', '.dockerfile', '.gradle', '.gitignore', '.gitattributes',
  '.editorconfig', '.prettierrc', '.eslintrc', '.npmrc', '.nvmrc', '.r', '.rmd', '.lua', '.pl',
  '.ex', '.exs', '.erl', '.hrl', '.clj', '.cljs', '.cljc', '.edn', '.lisp', '.scm', '.dart', '.zig',
  '.jl', '.tf', '.tfvars', '.hcl', '.nix', '.cmake', '.diff', '.patch', '.svg'
] as const

const textExtensions = new Set<string>(TEXT_ATTACHMENT_EXTENSIONS)
const textNames = new Set(['readme', 'license', 'licence', 'copying', 'notice', 'dockerfile', 'makefile', 'procfile', 'gemfile', 'rakefile', 'vagrantfile'])
const textMedia = new Set([
  'application/json', 'application/ld+json', 'application/x-ndjson', 'application/jsonl',
  'application/xml', 'application/xhtml+xml', 'application/yaml', 'application/x-yaml',
  'application/toml', 'application/javascript', 'application/x-javascript', 'application/typescript',
  'application/sql', 'application/graphql', 'application/x-sh', 'application/x-shellscript', 'image/svg+xml'
])
const binaryExtensions = new Set([
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.odt', '.ods', '.odp', '.rtf',
  '.zip', '.gz', '.tar', '.7z', '.rar', '.exe', '.dll', '.bin', '.png', '.jpg', '.jpeg', '.gif',
  '.webp', '.ico', '.heic', '.mp4', '.mov', '.mp3', '.wav', '.ttf', '.woff', '.woff2'
])

export const TEXT_ATTACHMENT_ACCEPT = ['text/*', ...textMedia, ...TEXT_ATTACHMENT_EXTENSIONS].join(',')

export function isSupportedTextAttachment(filename: string, mediaType = ''): boolean {
  const name = filename.split(/[\\/]/).pop()!.toLowerCase()
  const extension = name.includes('.') ? name.slice(name.lastIndexOf('.')) : ''
  const mime = mediaType.split(';')[0]!.trim().toLowerCase()
  if (binaryExtensions.has(extension)) return false
  if (/^(?:audio|video|font)\//.test(mime) || (mime.startsWith('image/') && mime !== 'image/svg+xml')) return false
  if (/^(?:application\/(?:pdf|rtf|msword|vnd\.ms-|vnd\.openxmlformats-|vnd\.oasis\.opendocument|zip|gzip|x-7z|x-rar)|text\/rtf)/.test(mime)) return false
  return /^text\/.+/.test(mime) || textMedia.has(mime) || textExtensions.has(extension) ||
    textNames.has(name) || name.startsWith('.env.')
}

/** Decode text without silently replacing malformed UTF-8 or treating binary as prose. */
export function decodeAttachmentText(bytes: Uint8Array): string {
  if (bytes.byteLength > TEXT_ATTACHMENT_MAX_BYTES) throw new Error('Text files must be 256 KiB or smaller.')
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new Error('The file is not valid UTF-8 text. Save it as UTF-8 and attach it again.')
  }
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text) || /^%PDF-|^\{\\rtf\d/i.test(text)) {
    throw new Error('The file contains binary data. Attach a UTF-8 text or source file instead.')
  }
  return text
}
