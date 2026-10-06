import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * What Ollama's public registry says about a model, so a download can be sized
 * (and the disk checked) before the first byte. Only the default registry is
 * asked: other hosts, such as hf.co, are not, and report no size.
 */

export const OLLAMA_REGISTRY_HOST = 'registry.ollama.ai'

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const HOST = /^[A-Za-z0-9][A-Za-z0-9.-]{0,252}(?::\d{1,5})?$/
const SHA256 = /^sha256:([0-9a-f]{64})$/
const MAX_LAYERS = 64
const DEFAULT_TIMEOUT_MS = 4000

export interface OllamaModelRef {
  host: string
  namespace: string
  name: string
  tag: string
}

/**
 * `llama3.1:8b`, `llama3.1`, `someone/model:tag`, `hf.co/owner/repo:Q4_K_M`.
 * Returns undefined for anything that could not be a model name, which also
 * keeps it out of the registry URL.
 */
export function parseOllamaModelRef(input: string): OllamaModelRef | undefined {
  const text = input.trim()
  if (!text || text.length > 255 || /\s/.test(text)) return undefined
  const parts = text.split('/')
  if (parts.length > 3) return undefined
  const last = parts.pop()!
  const colon = last.lastIndexOf(':')
  const name = colon === -1 ? last : last.slice(0, colon)
  const tag = colon === -1 ? 'latest' : last.slice(colon + 1)
  const namespace = parts.length > 0 ? parts[parts.length - 1]! : 'library'
  const host = parts.length > 1 ? parts[0]! : OLLAMA_REGISTRY_HOST
  if (!SEGMENT.test(name) || !SEGMENT.test(tag) || !SEGMENT.test(namespace) || !HOST.test(host)) return undefined
  return { host, namespace, name, tag }
}

/** Where Ollama keeps its models: OLLAMA_MODELS when set, otherwise `.ollama/models` in the home folder. */
export function ollamaModelsDir(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const custom = env.OLLAMA_MODELS?.trim()
  return custom ? custom : join(home, '.ollama', 'models')
}

export interface ManifestBlob {
  digest: string
  size: number
}

/** The blobs a manifest names (its config and every layer), or undefined when it is not a manifest. */
export function parseOllamaManifest(json: unknown): ManifestBlob[] | undefined {
  if (typeof json !== 'object' || json === null) return undefined
  const { config, layers } = json as { config?: unknown; layers?: unknown }
  if (!Array.isArray(layers) || layers.length === 0 || layers.length > MAX_LAYERS) return undefined
  const blobs: ManifestBlob[] = []
  for (const entry of [config, ...layers]) {
    if (entry === undefined) continue
    const blob = entry as { digest?: unknown; size?: unknown }
    if (typeof blob.digest !== 'string' || !SHA256.test(blob.digest)) return undefined
    if (typeof blob.size !== 'number' || !Number.isSafeInteger(blob.size) || blob.size < 0) return undefined
    blobs.push({ digest: blob.digest, size: blob.size })
  }
  return blobs
}

export interface ManifestRequest {
  fetch?: typeof fetch
  signal?: AbortSignal
  timeoutMs?: number
}

/** The model's blobs from the registry; undefined when it cannot be reached or does not know the model. */
export async function fetchOllamaManifest(ref: OllamaModelRef, options: ManifestRequest = {}): Promise<ManifestBlob[] | undefined> {
  if (ref.host !== OLLAMA_REGISTRY_HOST) return undefined
  const timeout = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
  try {
    const res = await (options.fetch ?? fetch)(`https://${ref.host}/v2/${ref.namespace}/${ref.name}/manifests/${ref.tag}`, {
      headers: { accept: 'application/vnd.docker.distribution.manifest.v2+json' },
      signal
    })
    if (!res.ok) return undefined
    return parseOllamaManifest(await res.json())
  } catch {
    return undefined
  }
}

/**
 * How many bytes of these blobs Ollama already has: a finished blob counts in full, and an
 * interrupted one by the partial files it left (`sha256-<hex>-partial`, with a part number
 * when it downloaded in pieces), so a retry is sized by what is still missing.
 */
export async function blobBytesOnDisk(modelsDir: string, blobs: readonly ManifestBlob[]): Promise<number> {
  const dir = join(modelsDir, 'blobs')
  const names = await readdir(dir).catch(() => [] as string[])
  let present = 0
  for (const blob of blobs) {
    const stem = `sha256-${SHA256.exec(blob.digest)![1]}`
    let have = 0
    for (const name of names) {
      if (name !== stem && !name.startsWith(`${stem}-partial`)) continue
      const size = (await stat(join(dir, name)).catch(() => undefined))?.size ?? 0
      if (name === stem && size === blob.size) {
        have = blob.size
        break
      }
      if (name !== stem) have += size
    }
    present += Math.min(have, blob.size)
  }
  return present
}
