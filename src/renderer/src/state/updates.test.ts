import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { UpdateInstallResult, UpdateState } from '../../../shared/updates'
import { dismissalKey } from '../lib/updateText'

const mocks = vi.hoisted(() => ({
  listeners: new Set<(state: UpdateState) => void>(),
  get: vi.fn(),
  check: vi.fn(),
  download: vi.fn(),
  cancel: vi.fn(),
  install: vi.fn(),
  skip: vi.fn(),
  openPage: vi.fn()
}))
vi.mock('../lib/api', () => ({
  api: {
    getUpdateState: () => mocks.get(),
    checkForUpdates: () => mocks.check(),
    downloadUpdate: () => mocks.download(),
    cancelUpdateDownload: () => mocks.cancel(),
    installUpdate: (request?: unknown) => mocks.install(request),
    skipUpdate: (version: string) => mocks.skip(version),
    openUpdatePage: () => mocks.openPage(),
    onUpdateState: (cb: (state: UpdateState) => void) => { mocks.listeners.add(cb); return () => { mocks.listeners.delete(cb) } }
  }
}))

import { announcedUpdate, putOffUpdate, useUpdates } from './updates'

const found = (stage: 'available' | 'downloading' | 'ready' | 'installing' = 'available', extra: object = {}): UpdateState => ({
  currentVersion: '0.1.0',
  canInstall: true,
  check: { status: 'done', at: 1 },
  update: { info: { version: '0.2.0', name: 'Cubex 0.2.0', notes: '- A thing', pageUrl: 'https://github.com/HeshamXOR/Cubex/releases/tag/v0.2.0', installer: { name: 'Cubex-Setup-0.2.0.exe', size: 100 } }, stage, ...extra }
})
const idle: UpdateState = { currentVersion: '0.1.0', canInstall: true, check: { status: 'idle' } }
const push = (state: UpdateState): void => mocks.listeners.forEach((listener) => listener(state))
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  mocks.listeners.clear()
  for (const mock of [mocks.get, mocks.check, mocks.download, mocks.cancel, mocks.install, mocks.skip, mocks.openPage]) mock.mockReset()
  mocks.get.mockResolvedValue(idle)
  useUpdates.setState(useUpdates.getInitialState(), true)
})

describe('listening', () => {
  it('reads the first state and follows what the main process pushes', async () => {
    mocks.get.mockResolvedValue(found())
    const stop = useUpdates.getState().start()
    expect(useUpdates.getState().loaded).toBe(false)
    await flush()
    expect(useUpdates.getState()).toMatchObject({ loaded: true, state: { update: { stage: 'available' } } })
    push(found('downloading', { progress: { received: 10, total: 100 } }))
    expect(useUpdates.getState().state.update).toMatchObject({ stage: 'downloading', progress: { received: 10 } })
    stop()
    expect(mocks.listeners.size).toBe(0)
  })

  it('lets a push that came first win over the first read, which was asked earlier', async () => {
    let answer: (state: UpdateState) => void = () => undefined
    mocks.get.mockReturnValue(new Promise<UpdateState>((resolve) => { answer = resolve }))
    useUpdates.getState().start()
    push(found('ready'))
    answer(found('available'))
    await flush()
    expect(useUpdates.getState().state.update?.stage).toBe('ready')
  })

  it('ignores the first read when it stopped listening before it came', async () => {
    let answer: (state: UpdateState) => void = () => undefined
    mocks.get.mockReturnValue(new Promise<UpdateState>((resolve) => { answer = resolve }))
    const stop = useUpdates.getState().start()
    stop()
    answer(found())
    await flush()
    expect(useUpdates.getState().loaded).toBe(false)
  })

  it('carries on without an update when the main process cannot answer', async () => {
    mocks.get.mockRejectedValue(new Error('no handler'))
    useUpdates.getState().start()
    await flush()
    expect(useUpdates.getState()).toMatchObject({ loaded: true, state: { currentVersion: '' } })
  })
})

describe('asking for steps', () => {
  it('checks, and shows that it is working while it is', async () => {
    let finish: (state: UpdateState) => void = () => undefined
    mocks.check.mockReturnValue(new Promise<UpdateState>((resolve) => { finish = resolve }))
    const running = useUpdates.getState().check()
    expect(useUpdates.getState().pending).toBe('check')
    finish(found())
    await running
    expect(useUpdates.getState()).toMatchObject({ pending: undefined, state: { update: { stage: 'available' } } })
  })

  it('says what went wrong when a request fails, and is ready to try again', async () => {
    mocks.download.mockRejectedValue(new Error('Error invoking remote method'))
    await useUpdates.getState().download()
    expect(useUpdates.getState()).toMatchObject({ problem: 'Error invoking remote method', pending: undefined })
    mocks.download.mockRejectedValue('odd')
    await useUpdates.getState().download()
    expect(useUpdates.getState().problem).toBe('Something went wrong. Try again.')
    mocks.download.mockResolvedValue(found('downloading'))
    await useUpdates.getState().download()
    expect(useUpdates.getState().problem).toBeUndefined()
  })

  it('downloads and cancels through the main process', async () => {
    mocks.download.mockResolvedValue(found('downloading', { progress: { received: 0, total: 100 } }))
    await useUpdates.getState().download()
    expect(useUpdates.getState().state.update?.stage).toBe('downloading')
    mocks.cancel.mockResolvedValue(found('available'))
    await useUpdates.getState().cancelDownload()
    expect(useUpdates.getState().state.update?.stage).toBe('available')
  })
})

describe('installing', () => {
  it('asks to restart without force at first', async () => {
    mocks.install.mockResolvedValue({ ok: true } satisfies UpdateInstallResult)
    await useUpdates.getState().install()
    expect(mocks.install).toHaveBeenCalledWith(undefined)
    expect(useUpdates.getState()).toMatchObject({ busy: undefined, problem: undefined, pending: undefined })
  })

  it('keeps what is running, so the window can ask, and goes ahead only when told to', async () => {
    mocks.install.mockResolvedValueOnce({ ok: false, reason: 'busy', busy: { turns: 1, tasks: 2 } } satisfies UpdateInstallResult)
    await useUpdates.getState().install()
    expect(useUpdates.getState().busy).toEqual({ turns: 1, tasks: 2 })
    mocks.install.mockResolvedValueOnce({ ok: true })
    await useUpdates.getState().install(true)
    expect(mocks.install).toHaveBeenLastCalledWith({ force: true })
    expect(useUpdates.getState().busy).toBeUndefined()
  })

  it('lets the person wait for the work to end', async () => {
    mocks.install.mockResolvedValue({ ok: false, reason: 'busy', busy: { turns: 1, tasks: 0 } })
    await useUpdates.getState().install()
    useUpdates.getState().waitForWork()
    expect(useUpdates.getState().busy).toBeUndefined()
  })

  it('reports a failure to start in a sentence', async () => {
    mocks.install.mockResolvedValue({ ok: false, reason: 'failed', message: 'Cubex could not start the installer (spawn UNKNOWN). Open C:\\x.exe yourself to finish.' })
    await useUpdates.getState().install()
    expect(useUpdates.getState().problem).toMatch(/could not start the installer/)
  })

  it('reports a request that threw', async () => {
    mocks.install.mockRejectedValue(new Error('gone'))
    await useUpdates.getState().install()
    expect(useUpdates.getState()).toMatchObject({ problem: 'gone', pending: undefined })
  })
})

describe('putting an update off', () => {
  it('hides the announcement for that stage and keeps a quiet way back', () => {
    useUpdates.setState({ state: found() })
    expect(announcedUpdate(useUpdates.getState())?.stage).toBe('available')
    expect(putOffUpdate(useUpdates.getState())).toBeUndefined()
    useUpdates.getState().openDialog()
    useUpdates.getState().dismiss()
    expect(useUpdates.getState()).toMatchObject({ dialogOpen: false, dismissed: '0.2.0:available' })
    expect(announcedUpdate(useUpdates.getState())).toBeUndefined()
    expect(putOffUpdate(useUpdates.getState())?.stage).toBe('available')
  })

  it('announces again when the update moves on, fails, or a newer one comes', () => {
    useUpdates.setState({ state: found(), dismissed: '0.2.0:available' })
    useUpdates.setState({ state: found('downloading') })
    expect(announcedUpdate(useUpdates.getState())?.stage).toBe('downloading')
    useUpdates.setState({ state: found('available', { error: 'The download stopped.' }) })
    expect(announcedUpdate(useUpdates.getState())?.error).toBe('The download stopped.')
    const newer = found()
    if (newer.update) newer.update.info.version = '0.3.0'
    useUpdates.setState({ state: newer })
    expect(announcedUpdate(useUpdates.getState())?.info.version).toBe('0.3.0')
  })

  it('does not announce a version that was skipped, and does not offer a link to it either', () => {
    useUpdates.setState({ state: found('available', { skipped: true }) })
    expect(announcedUpdate(useUpdates.getState())).toBeUndefined()
    expect(putOffUpdate(useUpdates.getState())).toBeUndefined()
  })

  it('is forgotten when nothing is on offer any more', () => {
    useUpdates.setState({ state: idle, dismissed: dismissalKey(found().update!) })
    expect(announcedUpdate(useUpdates.getState())).toBeUndefined()
    expect(putOffUpdate(useUpdates.getState())).toBeUndefined()
  })
})

describe('skipping', () => {
  it('skips the version on offer, closes the dialog and takes the state it gets back', async () => {
    useUpdates.setState({ state: found(), dialogOpen: true })
    mocks.skip.mockResolvedValue(found('available', { skipped: true }))
    await useUpdates.getState().skip()
    expect(mocks.skip).toHaveBeenCalledWith('0.2.0')
    expect(useUpdates.getState()).toMatchObject({ dialogOpen: false, state: { update: { skipped: true } } })
  })

  it('stays open and says why when it could not', async () => {
    useUpdates.setState({ state: found(), dialogOpen: true })
    mocks.skip.mockRejectedValue(new Error('That is not a version number.'))
    await useUpdates.getState().skip()
    expect(useUpdates.getState()).toMatchObject({ dialogOpen: true, problem: 'That is not a version number.' })
  })

  it('does nothing when nothing is on offer', async () => {
    await useUpdates.getState().skip()
    expect(mocks.skip).not.toHaveBeenCalled()
  })
})

describe('the dialog and the release page', () => {
  it('opens clean, and closing drops a question about running work', () => {
    useUpdates.setState({ problem: 'old', busy: { turns: 1, tasks: 0 } })
    useUpdates.getState().openDialog()
    expect(useUpdates.getState()).toMatchObject({ dialogOpen: true, problem: undefined })
    useUpdates.getState().closeDialog()
    expect(useUpdates.getState()).toMatchObject({ dialogOpen: false, busy: undefined })
  })

  it('opens the release page through the main process', async () => {
    await useUpdates.getState().openPage()
    expect(mocks.openPage).toHaveBeenCalledOnce()
  })

  it('says when the page could not be opened', async () => {
    mocks.openPage.mockRejectedValue(new Error('No application is registered'))
    await useUpdates.getState().openPage()
    expect(useUpdates.getState().problem).toBe('No application is registered')
  })
})
