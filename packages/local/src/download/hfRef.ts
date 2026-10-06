/**
 * Hugging Face references for direct GGUF downloads: parse what the user typed,
 * list the repository's files through the public API, and choose which GGUF
 * file(s) to fetch. Pure functions plus one fetch-based resolver, so everything
 * is testable without a network.
 */

export interface HfReference {
  /** `owner/name`. */
  repo: string
  /** Branch, tag or commit. Defaults to `main`. */
  revision: string
  /** Path of one GGUF file inside the repository. */
  file?: string
  /** Quantization label such as `Q4_K_M`, used to pick a file when `file` is absent. */
  quant?: string
}

/** One entry of `GET /api/models/<repo>/tree/<revision>`. */
export interface HfTreeEntry {
  type: string
  path: string
  size?: number
  lfs?: { oid?: string; size?: number; pointerSize?: number }
}

export interface HfFile {
  path: string
  size: number
  /** From the LFS pointer; present for every large file Hugging Face stores. */
  sha256?: string
}

export interface HfPlan {
  repo: string
  revision: string
  /** In download order; the first is the one to load (the first part of a split model). */
  files: HfFile[]
}

const HF_HOSTS = new Set(['huggingface.co', 'www.huggingface.co', 'hf.co'])
const HF_API_ORIGIN = 'https://huggingface.co'
const REPO_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/
const REVISION = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i

/** A single path segment that is safe to create on Windows, macOS and Linux. */
export function isSafePathSegment(segment: string): boolean {
  if (!segment || segment === '.' || segment === '..' || segment.length > 200) return false
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f<>:"/\\|?*]/.test(segment)) return false
  if (/[. ]$/.test(segment)) return false
  return !WINDOWS_RESERVED.test(segment)
}

function validateFilePath(path: string): string {
  const segments = path.split('/')
  if (!segments.every(isSafePathSegment)) throw new Error(`"${path}" is not a safe file path.`)
  if (!/\.gguf$/i.test(path)) throw new Error('Only .gguf files can be downloaded here.')
  return path
}

function validateRepoSegments(owner: string | undefined, name: string | undefined, original: string): string {
  if (!owner || !name || !REPO_SEGMENT.test(owner) || !REPO_SEGMENT.test(name)) {
    throw new Error(`"${original}" is not a Hugging Face model reference. Use owner/name, optionally followed by :QUANT (for example bartowski/Meta-Llama-3.1-8B-Instruct-GGUF:Q4_K_M).`)
  }
  return `${owner}/${name}`
}

function validateRevision(revision: string): string {
  if (!REVISION.test(revision) || revision.split('/').some((s) => s === '..' || s === '')) {
    throw new Error(`"${revision}" is not a valid revision.`)
  }
  return revision
}

/**
 * Accepts `owner/repo`, `owner/repo:QUANT`, `owner/repo/path/file.gguf`, an
 * optional `hf.co/` or `huggingface.co/` prefix (the Ollama notation), and full
 * `https://huggingface.co/...` resolve/blob/tree links. Anything pointing at
 * another host is refused so the app never fetches arbitrary URLs for the user.
 */
export function parseHfReference(input: string, options: { file?: string; revision?: string } = {}): HfReference {
  const text = input.trim()
  if (!text) throw new Error('Enter a Hugging Face model, for example owner/name:Q4_K_M.')

  let revision = 'main'
  let file: string | undefined
  let quant: string | undefined
  let repo: string

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    let url: URL
    try {
      url = new URL(text)
    } catch {
      throw new Error(`"${text}" is not a valid link.`)
    }
    if (url.protocol !== 'https:' || !HF_HOSTS.has(url.hostname.toLowerCase())) {
      throw new Error('Only Hugging Face links (https://huggingface.co or https://hf.co) are supported.')
    }
    const parts = url.pathname.split('/').filter(Boolean).map((p) => decodeURIComponent(p))
    repo = validateRepoSegments(parts[0], parts[1], text)
    const kind = parts[2]
    if (kind === 'resolve' || kind === 'blob' || kind === 'tree' || kind === 'raw') {
      if (parts[3]) revision = parts[3]
      const rest = parts.slice(4)
      if (rest.length > 0 && kind !== 'tree') file = rest.join('/')
    }
  } else {
    const stripped = text.replace(/^(?:www\.)?(?:huggingface\.co|hf\.co)\//i, '')
    if (/^(?:[a-z0-9-]+\.)+[a-z]{2,}\//i.test(stripped)) {
      throw new Error('Only Hugging Face links (https://huggingface.co or https://hf.co) are supported.')
    }
    const parts = stripped.split('/')
    let name = parts[1]
    const colon = name?.indexOf(':') ?? -1
    if (name && colon !== -1) {
      quant = name.slice(colon + 1)
      name = name.slice(0, colon)
      if (!/^[A-Za-z0-9_.-]{2,40}$/.test(quant)) throw new Error(`"${quant}" is not a quantization label.`)
    }
    repo = validateRepoSegments(parts[0], name, text)
    if (parts.length > 2) file = parts.slice(2).join('/')
  }

  if (options.revision) revision = options.revision
  if (options.file) file = options.file
  validateRevision(revision)
  if (file !== undefined) {
    validateFilePath(file)
    quant = undefined // an exact file wins over a quantization label
  }
  return { repo, revision, ...(file !== undefined ? { file } : {}), ...(quant ? { quant } : {}) }
}

// --- File selection ---------------------------------------------------------

const SPLIT = /^(.*)-(\d{5})-of-(\d{5})\.gguf$/i
const PREFERRED_QUANTS = ['Q4_K_M', 'Q4_K_S', 'Q5_K_M', 'Q5_K_S', 'Q4_0', 'Q6_K', 'Q8_0']
const QUANT_LABEL = /(?<![A-Za-z0-9_])((?:UD-)?(?:IQ|Q)\d(?:_[A-Z0-9]+)*|BF16|F16|F32)(?![A-Za-z0-9_])/gi

function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function toHfFile(entry: HfTreeEntry): HfFile {
  const oid = entry.lfs?.oid
  return {
    path: entry.path,
    size: entry.lfs?.size ?? entry.size ?? 0,
    ...(oid && /^[0-9a-f]{64}$/i.test(oid) ? { sha256: oid.toLowerCase() } : {})
  }
}

function matchesQuant(path: string, quant: string): boolean {
  return new RegExp(`(?<![A-Za-z0-9_])${escapeRegex(quant)}(?![A-Za-z0-9_])`, 'i').test(baseName(path))
}

function availableQuants(files: HfFile[]): string[] {
  const found = new Set<string>()
  for (const f of files) {
    for (const m of baseName(f.path).matchAll(QUANT_LABEL)) found.add(m[1]!.toUpperCase())
  }
  return [...found].sort()
}

/** All parts of the split set that `path` belongs to, in order; a single file yields itself. */
function expandSplit(path: string, all: HfFile[]): HfFile[] {
  const m = SPLIT.exec(baseName(path))
  const self = all.find((f) => f.path === path)
  if (!m || !self) return self ? [self] : []
  const dir = path.slice(0, path.length - baseName(path).length)
  const total = Number(m[3])
  const parts: HfFile[] = []
  for (let i = 1; i <= total; i++) {
    const name = `${m[1]}-${String(i).padStart(5, '0')}-of-${m[3]}.gguf`
    const part = all.find((f) => f.path === `${dir}${name}`)
    if (!part) throw new Error(`Part ${i} of ${total} of "${m[1]}" is missing from the repository, so the model cannot be downloaded.`)
    parts.push(part)
  }
  return parts
}

/** Group matching files into download units: a single file, or a complete split set. */
function toUnits(files: HfFile[], all: HfFile[]): HfFile[][] {
  const seen = new Set<string>()
  const units: HfFile[][] = []
  for (const f of files) {
    if (seen.has(f.path)) continue
    const unit = expandSplit(f.path, all)
    for (const part of unit) seen.add(part.path)
    units.push(unit)
  }
  return units
}

const unitSize = (unit: HfFile[]): number => unit.reduce((sum, f) => sum + f.size, 0)

/**
 * Choose which GGUF file(s) to download. An exact `file` wins; otherwise the
 * `quant` label picks the file; with neither, the first of a preference list
 * (Q4_K_M, Q4_K_S, ...) that exists, falling back to the smallest model. Vision
 * projector files (`mmproj*`) are never chosen implicitly. A split model returns
 * every part, so a half-downloaded model is never reported as complete.
 */
export function selectGgufFiles(tree: HfTreeEntry[], options: { file?: string; quant?: string }): HfFile[] {
  const ggufs = tree.filter((e) => e.type === 'file' && /\.gguf$/i.test(e.path)).map(toHfFile)
  if (ggufs.length === 0) throw new Error('This repository has no GGUF files.')

  if (options.file) {
    if (!ggufs.some((f) => f.path === options.file)) {
      throw new Error(`The file "${options.file}" was not found in this repository.`)
    }
    return expandSplit(options.file, ggufs)
  }

  const models = ggufs.filter((f) => !/^mmproj/i.test(baseName(f.path)))
  if (models.length === 0) throw new Error('This repository has no GGUF model files (only projector files).')

  let matching: HfFile[] = []
  if (options.quant) {
    matching = models.filter((f) => matchesQuant(f.path, options.quant!))
    if (matching.length === 0) {
      const have = availableQuants(models)
      throw new Error(
        `No GGUF file for "${options.quant}" in this repository.${have.length ? ` Available: ${have.join(', ')}.` : ''}`
      )
    }
  } else {
    for (const q of PREFERRED_QUANTS) {
      matching = models.filter((f) => matchesQuant(f.path, q))
      if (matching.length > 0) break
    }
    if (matching.length === 0) {
      const smallest = toUnits(models, ggufs).sort((a, b) => unitSize(a) - unitSize(b))[0]!
      return smallest
    }
  }

  const units = toUnits(matching, ggufs)
  if (units.length > 1) {
    const names = units.map((u) => u[0]!.path).join(', ')
    throw new Error(`More than one file matches${options.quant ? ` "${options.quant}"` : ''}: ${names}. Name the exact file to download.`)
  }
  return units[0]!
}

// --- Tree lookup ------------------------------------------------------------

export interface HfDeps {
  fetch?: typeof fetch
  token?: string
  signal?: AbortSignal
}

function nextLink(header: string | null): string | undefined {
  if (!header) return undefined
  for (const part of header.split(',')) {
    const m = /<([^>]+)>\s*;\s*rel="?next"?/i.exec(part)
    if (m) return m[1]
  }
  return undefined
}

function statusMessage(status: number, repo: string): string {
  switch (status) {
    case 401:
      return `Hugging Face needs you to sign in to access "${repo}". Add a Hugging Face access token and try again.`
    case 403:
      return `Access to "${repo}" is gated or private. Accept its license on huggingface.co and use an access token that has access.`
    case 404:
      return `"${repo}" was not found on Hugging Face (or it is private).`
    case 429:
      return 'Hugging Face is rate limiting requests. Wait a minute and try again.'
    default:
      return `Hugging Face returned HTTP ${status} for "${repo}".`
  }
}

/** The error text for a failed download request, shared with the file downloader. */
export function hfStatusMessage(status: number, subject: string): string {
  return statusMessage(status, subject)
}

/** List the repository tree (following pagination) and choose the files for `ref`. */
export async function resolveHfPlan(ref: HfReference, deps: HfDeps = {}): Promise<HfPlan> {
  const doFetch = deps.fetch ?? fetch
  const headers: Record<string, string> = { accept: 'application/json' }
  if (deps.token) headers.authorization = `Bearer ${deps.token}`

  let url: string | undefined = `${HF_API_ORIGIN}/api/models/${ref.repo}/tree/${encodeURIComponent(ref.revision)}?recursive=true`
  const entries: HfTreeEntry[] = []
  for (let page = 0; url && page < 20; page++) {
    let res: Response
    try {
      res = await doFetch(url, { headers, ...(deps.signal ? { signal: deps.signal } : {}) })
    } catch (err) {
      if (deps.signal?.aborted) throw err
      throw new Error(`Could not reach Hugging Face: ${err instanceof Error ? err.message : String(err)}`)
    }
    if (!res.ok) throw new Error(statusMessage(res.status, ref.repo))
    const body = (await res.json()) as unknown
    if (Array.isArray(body)) entries.push(...(body as HfTreeEntry[]))
    const next = nextLink(res.headers.get('link'))
    // Only follow pagination to Hugging Face itself, so the token never leaves it.
    url = next && next.startsWith(`${HF_API_ORIGIN}/`) ? next : undefined
  }

  const files = selectGgufFiles(entries, { ...(ref.file ? { file: ref.file } : {}), ...(ref.quant ? { quant: ref.quant } : {}) })
  return { repo: ref.repo, revision: ref.revision, files }
}

/** The direct download URL of one file; redirects to the CDN are followed by fetch. */
export function hfResolveUrl(repo: string, revision: string, path: string): string {
  return `${HF_API_ORIGIN}/${repo}/resolve/${encodeURIComponent(revision)}/${path.split('/').map(encodeURIComponent).join('/')}`
}
