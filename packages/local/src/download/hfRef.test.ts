import { describe, expect, it } from 'vitest'
import { parseHfReference, selectGgufFiles, resolveHfPlan, type HfTreeEntry } from './hfRef'

describe('parseHfReference', () => {
  it.each([
    ['hf.co/bartowski/Meta-Llama-3.1-8B-Instruct-GGUF:Q4_K_M', { repo: 'bartowski/Meta-Llama-3.1-8B-Instruct-GGUF', quant: 'Q4_K_M', revision: 'main' }],
    ['huggingface.co/unsloth/Qwen3-8B-GGUF', { repo: 'unsloth/Qwen3-8B-GGUF', revision: 'main' }],
    ['bartowski/gemma-2-9b-it-GGUF', { repo: 'bartowski/gemma-2-9b-it-GGUF', revision: 'main' }],
    ['bartowski/gemma-2-9b-it-GGUF:IQ4_XS', { repo: 'bartowski/gemma-2-9b-it-GGUF', quant: 'IQ4_XS', revision: 'main' }],
    ['owner/repo/model-Q4_K_M.gguf', { repo: 'owner/repo', file: 'model-Q4_K_M.gguf', revision: 'main' }],
    [
      'https://huggingface.co/unsloth/Qwen3-8B-GGUF/resolve/main/Qwen3-8B-Q4_K_M.gguf',
      { repo: 'unsloth/Qwen3-8B-GGUF', file: 'Qwen3-8B-Q4_K_M.gguf', revision: 'main' }
    ],
    [
      'https://huggingface.co/unsloth/Qwen3-8B-GGUF/blob/abc123/sub/dir/x.gguf',
      { repo: 'unsloth/Qwen3-8B-GGUF', file: 'sub/dir/x.gguf', revision: 'abc123' }
    ],
    ['https://huggingface.co/unsloth/Qwen3-8B-GGUF', { repo: 'unsloth/Qwen3-8B-GGUF', revision: 'main' }]
  ])('parses %s', (input, expected) => {
    expect(parseHfReference(input)).toEqual(expected)
  })

  it('lets explicit file and revision options override the reference', () => {
    expect(parseHfReference('owner/repo', { file: 'a/b.gguf', revision: 'v2' })).toEqual({
      repo: 'owner/repo',
      file: 'a/b.gguf',
      revision: 'v2'
    })
  })

  it.each([
    '',
    'justonesegment',
    'https://evil.example.com/owner/repo/resolve/main/x.gguf',
    'http://huggingface.co.evil.com/owner/repo',
    'owner/repo/../../x.gguf',
    '../owner/repo',
    'owner/re po',
    'owner/repo/notgguf.bin',
    'owner/repo/C:/x.gguf',
    'owner/repo\\x.gguf'
  ])('rejects %j', (input) => {
    expect(() => parseHfReference(input)).toThrow()
  })

  it('names Hugging Face in the error for a foreign host', () => {
    expect(() => parseHfReference('https://example.com/o/r/resolve/main/x.gguf')).toThrow(/Hugging Face/)
  })

  it('rejects an unsafe explicit file option', () => {
    expect(() => parseHfReference('owner/repo', { file: '../x.gguf' })).toThrow()
    expect(() => parseHfReference('owner/repo', { file: 'x.bin' })).toThrow()
  })
})

const GB = 1_000_000_000
function entry(path: string, size = GB, oid?: string): HfTreeEntry {
  return { type: 'file', path, size, ...(oid ? { lfs: { oid, size, pointerSize: 134 } } : {}) }
}

describe('selectGgufFiles', () => {
  const tree: HfTreeEntry[] = [
    entry('README.md', 1200),
    entry('Model-Q2_K.gguf', 3 * GB, 'a'.repeat(64)),
    entry('Model-Q4_K_M.gguf', 5 * GB, 'b'.repeat(64)),
    entry('Model-Q4_K_S.gguf', 4.5 * GB, 'c'.repeat(64)),
    entry('Model-Q8_0.gguf', 8 * GB, 'd'.repeat(64)),
    entry('mmproj-Model-f16.gguf', GB, 'e'.repeat(64))
  ]
  const splitTree: HfTreeEntry[] = [
    entry('README.md', 1200),
    { type: 'directory', path: 'big', size: 0 },
    entry('big/Big-Q4_K_M-00002-of-00002.gguf', 10 * GB, '2'.repeat(64)),
    entry('big/Big-Q4_K_M-00001-of-00002.gguf', 40 * GB, '1'.repeat(64)),
    entry('big/Big-Q8_0-00001-of-00003.gguf', 40 * GB),
    entry('big/Big-Q8_0-00002-of-00003.gguf', 40 * GB),
    entry('big/Big-Q8_0-00003-of-00003.gguf', 20 * GB)
  ]

  it('picks the file matching a quantization and carries size and SHA-256 from the LFS entry', () => {
    const files = selectGgufFiles(tree, { quant: 'q4_k_s' })
    expect(files).toEqual([{ path: 'Model-Q4_K_S.gguf', size: 4.5 * GB, sha256: 'c'.repeat(64) }])
  })

  it('does not confuse Q4_K_M with other quantizations or the projector file', () => {
    const files = selectGgufFiles(tree, { quant: 'Q4_K_M' })
    expect(files.map((f) => f.path)).toEqual(['Model-Q4_K_M.gguf'])
  })

  it('defaults to Q4_K_M when neither a file nor a quantization is given', () => {
    expect(selectGgufFiles(tree, {}).map((f) => f.path)).toEqual(['Model-Q4_K_M.gguf'])
  })

  it('walks the preference list (Q4_K_M, Q4_K_S, Q5_K_M, ... Q8_0) before giving up', () => {
    const only = [entry('x-Q2_K.gguf', 3 * GB), entry('x-Q8_0.gguf', 8 * GB)]
    expect(selectGgufFiles(only, {}).map((f) => f.path)).toEqual(['x-Q8_0.gguf'])
  })

  it('falls back to the smallest GGUF when no preferred quantization exists', () => {
    const only = [entry('x-IQ3_XS.gguf', 3 * GB), entry('x-IQ2_M.gguf', 2 * GB)]
    expect(selectGgufFiles(only, {}).map((f) => f.path)).toEqual(['x-IQ2_M.gguf'])
  })

  it('selects an exact file path', () => {
    expect(selectGgufFiles(tree, { file: 'Model-Q8_0.gguf' }).map((f) => f.path)).toEqual(['Model-Q8_0.gguf'])
  })

  it('returns every part of a split model in order, from the first part', () => {
    const files = selectGgufFiles(splitTree, { quant: 'Q4_K_M' })
    expect(files.map((f) => f.path)).toEqual([
      'big/Big-Q4_K_M-00001-of-00002.gguf',
      'big/Big-Q4_K_M-00002-of-00002.gguf'
    ])
  })

  it('expands a single part path to the whole set', () => {
    const files = selectGgufFiles(splitTree, { file: 'big/Big-Q4_K_M-00002-of-00002.gguf' })
    expect(files.map((f) => f.path)).toEqual([
      'big/Big-Q4_K_M-00001-of-00002.gguf',
      'big/Big-Q4_K_M-00002-of-00002.gguf'
    ])
  })

  it('reports an incomplete split set instead of downloading half a model', () => {
    const broken = [entry('big/Big-Q4_K_M-00001-of-00003.gguf'), entry('big/Big-Q4_K_M-00003-of-00003.gguf')]
    expect(() => selectGgufFiles(broken, { quant: 'Q4_K_M' })).toThrow(/part 2 of 3/i)
  })

  it('throws a helpful error listing the quantizations that exist', () => {
    expect(() => selectGgufFiles(tree, { quant: 'Q6_K' })).toThrow(/Q6_K.*Q2_K.*Q4_K_M.*Q8_0/s)
  })

  it('throws when the repository has no GGUF files', () => {
    expect(() => selectGgufFiles([entry('README.md')], {})).toThrow(/GGUF/)
  })
})

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init })
}

describe('resolveHfPlan', () => {
  it('lists the tree through the API and selects files, sending the token only to the API host', async () => {
    const seen: Array<{ url: string; auth: string | null }> = []
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(input), auth: new Headers(init?.headers).get('authorization') })
      return jsonResponse([entry('m-Q4_K_M.gguf', 5 * GB, 'f'.repeat(64)), entry('m-Q8_0.gguf', 8 * GB)])
    }) as typeof fetch
    const plan = await resolveHfPlan(
      { repo: 'o/r', revision: 'main', quant: 'Q4_K_M' },
      { fetch: fetchImpl, token: 'hf_secret' }
    )
    expect(plan.files).toEqual([{ path: 'm-Q4_K_M.gguf', size: 5 * GB, sha256: 'f'.repeat(64) }])
    expect(seen[0]!.url).toBe('https://huggingface.co/api/models/o/r/tree/main?recursive=true')
    expect(seen[0]!.auth).toBe('Bearer hf_secret')
  })

  it('follows pagination links', async () => {
    const pages = new Map<string, Response>()
    pages.set(
      'https://huggingface.co/api/models/o/r/tree/main?recursive=true',
      jsonResponse([entry('a-Q2_K.gguf', GB)], {
        headers: { link: '<https://huggingface.co/api/models/o/r/tree/main?recursive=true&cursor=2>; rel="next"' }
      })
    )
    pages.set(
      'https://huggingface.co/api/models/o/r/tree/main?recursive=true&cursor=2',
      jsonResponse([entry('a-Q4_K_M.gguf', 2 * GB)])
    )
    const fetchImpl = (async (input: string | URL | Request) => pages.get(String(input))!) as typeof fetch
    const plan = await resolveHfPlan({ repo: 'o/r', revision: 'main', quant: 'Q4_K_M' }, { fetch: fetchImpl })
    expect(plan.files.map((f) => f.path)).toEqual(['a-Q4_K_M.gguf'])
  })

  it.each([
    [404, /not found/i],
    [401, /(sign in|token|gated|private)/i],
    [403, /(license|gated|token)/i]
  ])('turns HTTP %i into a clear message', async (status, pattern) => {
    const fetchImpl = (async () => new Response('nope', { status })) as typeof fetch
    await expect(resolveHfPlan({ repo: 'o/r', revision: 'main' }, { fetch: fetchImpl })).rejects.toThrow(pattern)
  })

  it('resolves a direct file reference through the tree for its size and SHA-256', async () => {
    const fetchImpl = (async () => jsonResponse([entry('only.gguf', GB, '9'.repeat(64))])) as typeof fetch
    const plan = await resolveHfPlan({ repo: 'o/r', revision: 'main', file: 'only.gguf' }, { fetch: fetchImpl })
    expect(plan.files[0]).toMatchObject({ path: 'only.gguf', sha256: '9'.repeat(64) })
  })
})
