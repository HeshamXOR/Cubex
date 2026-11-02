import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AntigravityInstallState } from '@shared/antigravity'
import { AntigravityInstaller, InstallError, type AntigravityExecutable, type InstallerOptions } from './install'
import { antigravityProgramNames, type AntigravityReleaseAsset } from './release'
import { makeZip, type Member } from './testing/makeZip'

const platform = process.platform
const arch = process.arch
const names = antigravityProgramNames(platform)
const EXECUTABLE = Buffer.from(`runtime\n${'e'.repeat(4_000)}`)
const HARNESS = Buffer.from(`harness\n${'h'.repeat(3_000)}`)
const MODE = ((0o100755 << 16) >>> 0)

interface Release {
  asset: AntigravityReleaseAsset
  zip: Buffer
}

/** A release the size of a test: a real archive of two programs, and the numbers a pin holds for it. */
function release(members: Member[] = [{ name: names.executable, data: EXECUTABLE, attributes: MODE }, { name: names.harness, data: HARNESS, attributes: MODE }], over: Partial<AntigravityReleaseAsset> = {}): Release {
  const zip = makeZip(members)
  return {
    zip,
    asset: {
      version: '1.3.0',
      url: 'https://downloads.example/agy-acp-server.zip',
      sha256: createHash('sha256').update(zip).digest('hex'),
      archiveBytes: zip.length,
      executable: { name: names.executable, bytes: EXECUTABLE.length },
      harness: { name: names.harness, bytes: HARNESS.length },
      ...over
    }
  }
}

const serve = (body: Buffer, headers: Record<string, string> = {}, status = 200): typeof fetch => async () => new Response(new Uint8Array(body), { status, headers: { 'content-length': String(body.length), ...headers } })

/** A download that takes a while and stops when it is told to. */
function slowServe(body: Buffer, chunk = 600, delay = 10): typeof fetch {
  return async (_url, init) => {
    const signal = init?.signal
    let offset = 0
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (signal?.aborted) { controller.error(new DOMException('The operation was aborted.', 'AbortError')); return }
        if (offset >= body.length) { controller.close(); return }
        await new Promise((done) => setTimeout(done, delay))
        controller.enqueue(new Uint8Array(body.subarray(offset, offset + chunk)))
        offset += chunk
      }
    })
    return new Response(stream, { status: 200, headers: { 'content-length': String(body.length) } })
  }
}

let base: string
beforeEach(() => { base = mkdtempSync(join(tmpdir(), 'cubex-agy-install-')) })
afterEach(() => rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))

interface Made {
  installer: AntigravityInstaller
  validated: Array<{ executable: AntigravityExecutable; version: string }>
  states: AntigravityInstallState[]
  fetched: string[]
}

function make(rel: Release | null, over: Partial<InstallerOptions> = {}, fetcher?: typeof fetch): Made {
  const validated: Made['validated'] = []
  const fetched: string[] = []
  const given = fetcher ?? (rel ? serve(rel.zip) : serve(Buffer.alloc(0)))
  const installer = new AntigravityInstaller({
    base,
    platform,
    arch,
    asset: rel ? rel.asset : null,
    fetch: (async (url: string | URL | Request, init?: RequestInit) => { fetched.push(String(url)); return given(url, init) }) as typeof fetch,
    validate: async (executable, version) => { validated.push({ executable, version }) },
    freeBytes: () => undefined,
    ...over
  })
  const states: AntigravityInstallState[] = []
  installer.subscribe((state) => states.push(state))
  return { installer, validated, states, fetched }
}

const versions = (): string[] => {
  try { return readdirSync(join(base, 'runtime', `${platform}-${arch}`, 'versions')) } catch { return [] }
}
const activePath = (): string => join(base, 'runtime', `${platform}-${arch}`, 'active.json')

describe('installing', () => {
  it('downloads the release, checks it, unpacks it, starts it to see what it is, and only then makes it the one in use', async () => {
    const rel = release()
    const { installer, validated, states, fetched } = make(rel)
    const first = installer.start()
    expect(first).toMatchObject({ phase: 'downloading', totalBytes: rel.asset.archiveBytes, version: '1.3.0', installedVersion: null })
    await installer.finished()
    expect(fetched).toEqual([rel.asset.url])
    expect(installer.state).toMatchObject({ phase: 'succeeded', installedVersion: '1.3.0', canRemove: true, message: null, downloadedBytes: rel.asset.archiveBytes })
    expect(states.map((state) => state.phase)).toEqual(expect.arrayContaining(['downloading', 'extracting', 'verifying', 'succeeded']))
    const order = states.map((state) => state.phase)
    expect(order.indexOf('downloading')).toBeLessThan(order.indexOf('extracting'))
    expect(order.indexOf('extracting')).toBeLessThan(order.indexOf('verifying'))
    expect(order.indexOf('verifying')).toBeLessThan(order.indexOf('succeeded'))
    // What it started was the pair of programs, in a folder that was not yet the one in use, at the version it expected.
    expect(validated).toHaveLength(1)
    expect(validated[0]!.version).toBe('1.3.0')
    expect(validated[0]!.executable.executablePath.endsWith(names.executable)).toBe(true)
    // After: the release is in a folder named for its hash, and the pointer says so; nothing else is left.
    const found = installer.resolve()!
    expect(found).toMatchObject({ source: 'managed', version: '1.3.0' })
    expect(found.executablePath).toBe(join(base, 'runtime', `${platform}-${arch}`, 'versions', rel.asset.sha256, names.executable))
    expect(readFileSync(found.executablePath).equals(EXECUTABLE)).toBe(true)
    expect(readFileSync(found.harnessPath).equals(HARNESS)).toBe(true)
    expect(JSON.parse(readFileSync(activePath(), 'utf8'))).toEqual({ releaseId: rel.asset.sha256 })
    expect(versions()).toEqual([rel.asset.sha256])
  })
})

describe('a download that is not the release', () => {
  const fails = async (rel: Release, fetcher: typeof fetch, message: RegExp, over: Partial<InstallerOptions> = {}): Promise<Made> => {
    const made = make(rel, over, fetcher)
    made.installer.start()
    await made.installer.finished()
    expect(made.installer.state.phase).toBe('failed')
    expect(made.installer.state.message).toMatch(message)
    // Nothing was installed, and nothing is left from trying.
    expect(existsSync(activePath())).toBe(false)
    expect(versions().filter((name) => !name.startsWith('.install-'))).toEqual([])
    expect(versions()).toEqual([])
    expect(made.validated).toEqual([])
    return made
  }

  it('fails its hash when one byte is different, however the sizes agree', async () => {
    const rel = release()
    const altered = Buffer.from(rel.zip)
    altered[altered.length - 40] = altered[altered.length - 40]! ^ 0xff
    await fails(rel, serve(altered), /failed its size or SHA-256 check\. Nothing was installed\./)
  })

  it('fails when it is shorter than the release', async () => {
    const rel = release()
    await fails(rel, serve(rel.zip.subarray(0, rel.zip.length - 10), { 'content-length': String(rel.zip.length) }), /failed its size or SHA-256 check/)
  })
})

describe('an archive that is not what was promised', () => {
  const fails = async (members: Member[], message: RegExp): Promise<void> => {
    const rel = release(members)
    // The hash is of this archive, so the download passes: it is the archive's contents that are wrong.
    const made = make(rel)
    made.installer.start()
    await made.installer.finished()
    expect(made.installer.state.phase).toBe('failed')
    expect(made.installer.state.message).toMatch(message)
    expect(existsSync(activePath())).toBe(false)
    expect(versions()).toEqual([])
    expect(made.validated).toEqual([])
  }
  const good = (): Member[] => [{ name: names.executable, data: EXECUTABLE, attributes: MODE }, { name: names.harness, data: HARNESS, attributes: MODE }]

  it('holds a member with a path in its name, however it is written', async () => {
    await fails([good()[0]!, { name: `sub/${names.harness}`, data: HARNESS, attributes: MODE }], /unexpected, unsafe, or incorrectly sized member/)
    await fails([good()[0]!, { name: `..\\${names.harness}`, data: HARNESS, attributes: MODE }], /unexpected, unsafe, or incorrectly sized member/)
  })

  it('holds a link in the place of a program', async () => {
    await fails([good()[0]!, { name: names.harness, data: HARNESS, attributes: ((0o120777 << 16) >>> 0) }], /unexpected, unsafe, or incorrectly sized member/)
  })
})

describe('a runtime that does not start, or is not the release', () => {
  it('is not installed, and the one that was there is still the one in use', async () => {
    const first = make(release())
    first.installer.start()
    await first.installer.finished()
    const before = readFileSync(activePath(), 'utf8')
    // A different release, whose runtime does not check out.
    const other = release([{ name: names.executable, data: Buffer.from(`different\n${'x'.repeat(4_000)}`), attributes: MODE }, { name: names.harness, data: HARNESS, attributes: MODE }])
    other.asset.executable.bytes = Buffer.from(`different\n${'x'.repeat(4_000)}`).length
    const second = make(other, { validate: async () => { throw new InstallError('The downloaded runtime did not identify as the expected Google Antigravity release.', 'verify') } })
    second.installer.start()
    await second.installer.finished()
    expect(second.installer.state).toMatchObject({ phase: 'failed', message: 'The downloaded runtime did not identify as the expected Google Antigravity release.' })
    expect(readFileSync(activePath(), 'utf8')).toBe(before)
    expect(versions()).toEqual([first.installer.resolve()!.managedVersionDirectory!.split(/[\\/]/).pop()])
  })
})

describe('cancelling', () => {
  it('stops the download, leaves nothing behind and the previous runtime as it was, and says so', async () => {
    const rel = release([{ name: names.executable, data: Buffer.alloc(20_000, 5), attributes: MODE, method: 0 }, { name: names.harness, data: HARNESS, attributes: MODE }])
    rel.asset.executable.bytes = 20_000
    const { installer, states } = make(rel, {}, slowServe(rel.zip, 500, 15))
    const started = installer.start()
    await new Promise((done) => setTimeout(done, 80))
    expect(installer.state.phase).toBe('downloading')
    installer.cancel(started.operationId!)
    await installer.finished()
    expect(installer.state).toMatchObject({ phase: 'cancelled', message: 'Installation cancelled. The previous runtime is unchanged.' })
    expect(states.at(-1)!.phase).toBe('cancelled')
    expect(versions()).toEqual([])
    expect(existsSync(activePath())).toBe(false)
  })
})

describe('removing', () => {
  it('removes what Cubex installed, and says there is nothing left to remove', async () => {
    const { installer } = make(release())
    installer.start()
    await installer.finished()
    installer.remove()
    expect(installer.state).toMatchObject({ phase: 'idle', installedVersion: null, canRemove: false })
    expect(installer.resolve()).toBeUndefined()
    expect(existsSync(join(base, 'runtime'))).toBe(true)
    expect(existsSync(join(base, 'runtime', `${platform}-${arch}`))).toBe(false)
  })

  it('is refused while a runtime is running from it, and works once that has ended', async () => {
    const { installer } = make(release())
    installer.start()
    await installer.finished()
    const release1 = installer.lease(installer.resolve()!)
    const release2 = installer.lease(installer.resolve()!)
    expect(() => installer.remove()).toThrow(/Antigravity is still running/)
    release1()
    release1()
    expect(() => installer.remove()).toThrow(/Antigravity is still running/)
    release2()
    expect(() => installer.remove()).not.toThrow()
  })
})

describe('finding what is installed', () => {
  const install = async (): Promise<AntigravityInstaller> => {
    const { installer } = make(release())
    installer.start()
    await installer.finished()
    return installer
  }

  it('is an error, not nothing, when the record of what is installed is damaged', async () => {
    const installer = await install()
    writeFileSync(activePath(), '{"releaseId": 5}')
    expect(() => installer.resolve()).toThrow(/record is invalid/)
    writeFileSync(activePath(), 'not json')
    expect(() => installer.resolve()).toThrow()
    writeFileSync(activePath(), JSON.stringify({ releaseId: 'f'.repeat(64) }))
    expect(() => installer.resolve()).toThrow()
  })

  it('takes a program from a folder the person names only when its harness is beside it', async () => {
    const folder = join(base, 'custom')
    mkdirSync(folder)
    const { installer } = make(release())
    writeFileSync(join(folder, names.executable), 'exe', { mode: 0o755 })
    expect(installer.fromExternal(join(folder, names.executable), 'override')).toBeUndefined()
    writeFileSync(join(folder, names.harness), 'harness', { mode: 0o755 })
    expect(installer.fromExternal(join(folder, names.executable), 'override')).toMatchObject({ source: 'override', version: null, managedVersionDirectory: null })
    expect(installer.fromExternal(join(folder, 'missing'), 'path')).toBeUndefined()
  })
})
