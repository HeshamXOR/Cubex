import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { UpdateState } from '@shared/updates'
import { resolveFeed } from './feed'
import { UpdateService } from './UpdateService'

/**
 * The whole update, over real HTTP: a small server stands in for GitHub, and the service uses Node's own fetch, a real
 * folder and real files. Only the start of the installer and the quit are faked, since they would end the test run.
 */

const SIZE = 3 * 1024 * 1024 + 123
const INSTALLER = Buffer.from(Array.from({ length: SIZE }, (_, index) => (index * 131 + (index >> 8)) & 255))
const SHA = createHash('sha256').update(INSTALLER).digest('hex')

interface Behaviour {
  /** Bytes after which the first request for the installer is cut, as a dropped connection is. */
  cutFirstAt?: number
  /** Serve this many bytes of the installer wrong (the first byte flipped). */
  corrupt?: boolean
  /** Send the installer to this address instead of the file server. */
  redirectTo?: string
  /** Answer the release request with this text and status instead of the release. */
  releaseAnswer?: { status: number; body: string }
}

let server: Server
let origin: string
let behaviour: Behaviour
let requests: Array<{ path: string; range: string | undefined; userAgent: string | undefined; cookie: string | undefined; authorization: string | undefined }>
let folder: string

function release(): unknown {
  return {
    tag_name: 'v0.2.0',
    name: 'Cubex 0.2.0',
    body: '## What is new\n\n- The first thing\n- The second thing',
    draft: false,
    prerelease: false,
    published_at: '2026-10-20T09:30:00Z',
    html_url: `${origin}/releases/v0.2.0`,
    assets: [{
      name: 'Cubex-Setup-0.2.0.exe',
      size: SIZE,
      state: 'uploaded',
      digest: `sha256:${SHA}`,
      browser_download_url: `${origin}/files/Cubex-Setup-0.2.0.exe`
    }]
  }
}

function serveInstaller(request: IncomingMessage, response: ServerResponse, firstRequest: boolean): void {
  const range = /^bytes=(\d+)-$/.exec(request.headers.range ?? '')
  const start = range ? Number(range[1]) : 0
  const body = behaviour.corrupt ? Buffer.concat([Buffer.from([INSTALLER[0]! ^ 255]), INSTALLER.subarray(1)]) : INSTALLER
  const slice = body.subarray(start)
  response.writeHead(range ? 206 : 200, {
    'content-type': 'application/octet-stream',
    'content-length': slice.length,
    ...(range ? { 'content-range': `bytes ${start}-${SIZE - 1}/${SIZE}` } : {}),
    'accept-ranges': 'bytes'
  })
  if (firstRequest && behaviour.cutFirstAt !== undefined) {
    response.write(slice.subarray(0, behaviour.cutFirstAt), () => response.destroy())
    return
  }
  response.end(slice)
}

beforeEach(async () => {
  behaviour = {}
  requests = []
  folder = await mkdtemp(join(tmpdir(), 'cubex-update-http-'))
  let installerRequests = 0
  server = createServer((request, response) => {
    const path = request.url ?? ''
    requests.push({
      path,
      range: request.headers.range,
      userAgent: request.headers['user-agent'],
      cookie: request.headers.cookie,
      authorization: request.headers.authorization
    })
    if (path === '/latest.json') {
      const answer = behaviour.releaseAnswer
      response.writeHead(answer?.status ?? 200, { 'content-type': 'application/json' })
      response.end(answer ? answer.body : JSON.stringify(release()))
    } else if (path === '/files/Cubex-Setup-0.2.0.exe') {
      response.writeHead(302, { location: behaviour.redirectTo ?? `${origin}/cdn/signed-1/Cubex-Setup-0.2.0.exe` })
      response.end()
    } else if (path === '/cdn/signed-1/Cubex-Setup-0.2.0.exe') {
      serveInstaller(request, response, installerRequests++ === 0)
    } else {
      response.writeHead(404).end()
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterEach(async () => {
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await rm(folder, { recursive: true, force: true })
})

function service(extra: { events?: string[]; pushed?: UpdateState[] } = {}): UpdateService {
  const events = extra.events ?? []
  return new UpdateService({
    currentVersion: '0.1.0',
    support: { canInstall: true },
    feed: resolveFeed(`${origin}/latest.json`),
    fetch: (input, init) => fetch(input, init),
    userAgent: 'Cubex/0.1.0',
    directory: join(folder, 'updates'),
    automatic: true,
    settings: () => ({ auto: true, localOnly: false }),
    saveSkippedVersion: () => undefined,
    push: (state) => { extra.pushed?.push(state) },
    busy: () => ({ turns: 0, tasks: 0 }),
    startInstaller: async (path) => { events.push(`start ${path}`) },
    quit: () => { events.push('quit') },
    openExternal: async (url) => { events.push(`open ${url}`) },
    download: { retryDelayMs: () => 0, stallTimeoutMs: 10_000 }
  })
}

describe('an update over real HTTP', () => {
  it('is found, downloaded through the redirect, verified, and handed to the installer', async () => {
    const events: string[] = []
    const pushed: UpdateState[] = []
    const updates = service({ events, pushed })

    const found = await updates.checkNow(true)
    expect(found.update).toMatchObject({ stage: 'available', info: { version: '0.2.0', pageUrl: `${origin}/releases/v0.2.0`, installer: { size: SIZE } } })
    expect(JSON.stringify(found)).not.toContain(SHA)
    expect(JSON.stringify(found)).not.toContain('/files/')

    const ready = await updates.download()
    expect(ready.update).toMatchObject({ stage: 'ready' })
    const path = join(folder, 'updates', 'Cubex-Setup-0.2.0.exe')
    expect(createHash('sha256').update(await readFile(path)).digest('hex')).toBe(SHA)
    expect(await readdir(join(folder, 'updates'))).toEqual(['Cubex-Setup-0.2.0.exe'])

    // The window saw the bytes come in, never going backwards, and finishing at the full size.
    const received = pushed.flatMap((state) => (state.update?.stage === 'downloading' && state.update.progress ? [state.update.progress.received] : []))
    expect(received.length).toBeGreaterThan(1)
    expect(received).toEqual([...received].sort((a, b) => a - b))
    expect(received.at(-1)).toBe(SIZE)
    expect(pushed.at(-1)?.update?.stage).toBe('ready')

    expect(await updates.install()).toEqual({ ok: true })
    expect(events).toEqual([`start ${path}`, 'quit'])
  })

  it('goes through the release page and the file server without a cookie or a login', async () => {
    const updates = service()
    await updates.checkNow(true)
    await updates.download()
    expect(requests.map((request) => request.path)).toEqual(['/latest.json', '/files/Cubex-Setup-0.2.0.exe', '/cdn/signed-1/Cubex-Setup-0.2.0.exe'])
    for (const request of requests) {
      expect(request.userAgent).toBe('Cubex/0.1.0')
      expect(request.cookie).toBeUndefined()
      expect(request.authorization).toBeUndefined()
    }
  })

  it('goes on from where a dropped connection stopped, instead of starting again', async () => {
    behaviour.cutFirstAt = 1_000_000
    const updates = service()
    await updates.checkNow(true)
    const ready = await updates.download()
    expect(ready.update?.stage).toBe('ready')
    const path = join(folder, 'updates', 'Cubex-Setup-0.2.0.exe')
    expect(createHash('sha256').update(await readFile(path)).digest('hex')).toBe(SHA)
    const installerRequests = requests.filter((request) => request.path.startsWith('/cdn/'))
    expect(installerRequests).toHaveLength(2)
    expect(installerRequests[0]?.range).toBeUndefined()
    // The second request asks for the rest of the file and nothing it already has.
    const resumedFrom = Number(/^bytes=(\d+)-$/.exec(installerRequests[1]?.range ?? '')?.[1])
    expect(resumedFrom).toBeGreaterThan(0)
    expect(resumedFrom).toBeLessThanOrEqual(1_000_000)
  })

  it('deletes a file whose bytes are not the ones that were announced, and runs nothing', async () => {
    behaviour.corrupt = true
    const events: string[] = []
    const updates = service({ events })
    await updates.checkNow(true)
    const state = await updates.download()
    expect(state.update).toMatchObject({ stage: 'available', error: expect.stringMatching(/did not match its checksum, so Cubex deleted it/) })
    expect(await readdir(join(folder, 'updates'))).toEqual([])
    expect(await updates.install()).toMatchObject({ ok: false })
    expect(events).toEqual([])
  })

  it('does not follow the file to another server, even one on this computer', async () => {
    const other = `http://localhost:${new URL(origin).port}/cdn/signed-1/Cubex-Setup-0.2.0.exe`
    behaviour.redirectTo = other
    const updates = service()
    await updates.checkNow(true)
    const state = await updates.download()
    expect(state.update?.error).toMatch(/server Cubex does not use for updates/)
    expect(requests.some((request) => request.path.startsWith('/cdn/'))).toBe(false)
  })

  it('says the answer could not be read when the server sends something that is not a release', async () => {
    behaviour.releaseAnswer = { status: 200, body: '<html><body>Not a release</body></html>' }
    const state = await service().checkNow(true)
    expect(state.check).toMatchObject({ status: 'failed', error: expect.stringMatching(/could not read/) })
    expect(state.update).toBeUndefined()
  })

  it('says GitHub has nothing published when the server answers that there is no release', async () => {
    behaviour.releaseAnswer = { status: 404, body: '{"message":"Not Found"}' }
    expect((await service().checkNow(true)).check.error).toMatch(/no published release/)
  })

  it('opens the page of the release the server named', async () => {
    const events: string[] = []
    const updates = service({ events })
    await updates.checkNow(true)
    await updates.openReleasePage()
    expect(events).toEqual([`open ${origin}/releases/v0.2.0`])
  })
})
