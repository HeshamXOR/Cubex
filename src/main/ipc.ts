import { dialog, ipcMain, type BrowserWindow } from 'electron'
import { nanoid } from 'nanoid'
import { IPC, type ChatEvent, type Conversation, type PullProgress } from '@shared/ipc'
import type { ProviderConfig } from '@core/types'
import type { BenchmarkResult } from '@core/types'
import { conversationRepo, presetRepo, providerRepo, usageRepo } from './db'
import { deleteSecret, setSecret } from './credentials'
import { getSettings, updateSettings } from './config'
import { recentLogs } from './logger'
import { ProviderManager } from './ProviderManager'
import { ChatService } from './ChatService'
import { LocalService } from './LocalService'
import { exportConversation, importConversation } from './exporter'

/**
 * Registers all IPC handlers. Each maps a channel to a service method. The
 * renderer never touches Node APIs directly — everything flows through here.
 */
export function registerIpc(getWindow: () => BrowserWindow | null): () => void {
  const providers = new ProviderManager()

  const send = (channel: string, payload: unknown): void => {
    getWindow()?.webContents.send(channel, payload)
  }

  const chat = new ChatService(providers, (e: ChatEvent) => send(IPC.chatEvent, e))
  const local = new LocalService(
    providers,
    (p: PullProgress & { pullId: string }) => send(IPC.pullProgress, p),
    (p: { benchId: string; done: boolean; result?: BenchmarkResult; progress?: number }) =>
      send(IPC.benchmarkProgress, p)
  )

  const handle = <T>(channel: string, fn: (...args: never[]) => T | Promise<T>): void => {
    ipcMain.handle(channel, (_event, ...args) => fn(...(args as never[])))
  }

  // --- Providers ---
  handle(IPC.listProviders, () => providerRepo.list())
  handle(IPC.saveProvider, async (cfg: ProviderConfig, secret?: string) => {
    if (secret && secret.length > 0) {
      const ref = cfg.credentialRef ?? `cred_${cfg.id}_${nanoid(6)}`
      const res = setSecret(ref, secret)
      if (res.ok) cfg.credentialRef = ref
    }
    providerRepo.save(cfg)
    providers.invalidate(cfg.id)
    return cfg
  })
  handle(IPC.deleteProvider, (id: string) => {
    const cfg = providerRepo.get(id)
    if (cfg?.credentialRef) deleteSecret(cfg.credentialRef)
    providerRepo.delete(id)
    providers.invalidate(id)
  })
  handle(IPC.testProvider, (id: string) => providers.test(id))
  handle(IPC.listModels, (providerId: string) => providers.listModels(providerId))

  // --- Chat ---
  handle(IPC.startChat, (req: Parameters<ChatService['start']>[0]) => chat.start(req))
  handle(IPC.cancelChat, (streamId: string) => chat.cancel(streamId))

  // --- Conversations ---
  handle(IPC.listConversations, () => conversationRepo.listSummaries())
  handle(IPC.getConversation, (id: string) => conversationRepo.get(id))
  handle(IPC.createConversation, (partial: Partial<Conversation>) => {
    const now = Date.now()
    const conv: Conversation = {
      id: partial.id ?? nanoid(),
      title: partial.title ?? 'New conversation',
      createdAt: now,
      updatedAt: now,
      execution: partial.execution ?? 'cloud',
      messages: partial.messages ?? [],
      ...(partial.providerId ? { providerId: partial.providerId } : {}),
      ...(partial.model ? { model: partial.model } : {}),
      ...(partial.presetId ? { presetId: partial.presetId } : {})
    }
    conversationRepo.create(conv)
    return conv
  })
  handle(IPC.updateConversation, (id: string, patch: Partial<Conversation>) =>
    conversationRepo.update(id, patch)
  )
  handle(IPC.deleteConversation, (id: string) => conversationRepo.delete(id))
  handle(IPC.searchConversations, (query: string) => conversationRepo.search(query))
  handle(IPC.exportConversation, (id: string, format: 'json' | 'markdown' | 'txt') =>
    exportConversation(id, format)
  )
  handle(IPC.importConversation, (data: string) => importConversation(data))

  // --- Presets ---
  handle(IPC.listPresets, () => presetRepo.list())
  handle(IPC.savePreset, (p: Parameters<typeof presetRepo.save>[0]) => {
    presetRepo.save(p)
    return p
  })
  handle(IPC.deletePreset, (id: string) => presetRepo.delete(id))

  // --- Settings ---
  handle(IPC.getSettings, () => getSettings())
  handle(IPC.updateSettings, (patch: Parameters<typeof updateSettings>[0]) => updateSettings(patch))

  // --- Hardware / recommendations ---
  handle(IPC.scanHardware, (force?: boolean) => local.scanHardware(force))
  handle(IPC.analyzeModels, (goal?: string) => local.analyzeModels(goal))

  // --- Local runtimes / models ---
  handle(IPC.listRuntimes, () => local.listRuntimes())
  handle(IPC.startRuntime, (id: string) => local.listRuntimes().then((r) => r.find((x) => x.id === id)!))
  handle(IPC.stopRuntime, (id: string) => local.listRuntimes().then((r) => r.find((x) => x.id === id)!))
  handle(IPC.listLocalModels, () => local.listLocalModels())
  handle(IPC.browseModels, (query?: string) => local.browseModels(query))
  handle(IPC.pullModel, (req: Parameters<LocalService['pull']>[0]) => local.pull(req))
  handle(IPC.cancelPull, (pullId: string) => local.cancelPull(pullId))
  handle(IPC.deleteLocalModel, (runtime: string, modelId: string) => local.deleteLocalModel(runtime, modelId))

  // --- Benchmarks ---
  handle(IPC.runBenchmark, (req: Parameters<LocalService['runBenchmark']>[0]) => local.runBenchmark(req))
  handle(IPC.cancelBenchmark, (benchId: string) => local.cancelBenchmark(benchId))
  handle(IPC.listBenchmarks, (modelId?: string) => local.listBenchmarks(modelId))

  // --- Usage / cost ---
  handle(IPC.getUsage, () => usageRepo.summary())

  // --- Logs ---
  handle(IPC.getLogs, (limit?: number) => recentLogs(limit))
  handle(IPC.exportLogs, () => JSON.stringify(recentLogs(5000), null, 2))

  // --- Window controls (the window is frameless; chrome lives in the UI) ---
  handle(IPC.windowMinimize, () => {
    getWindow()?.minimize()
  })
  handle(IPC.windowToggleMaximize, () => {
    const win = getWindow()
    if (!win) return false
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
    return win.isMaximized()
  })
  handle(IPC.windowClose, () => {
    getWindow()?.close()
  })
  handle(IPC.windowIsMaximized, () => getWindow()?.isMaximized() ?? false)

  // --- Workspace ---
  handle(IPC.pickWorkspace, async () => {
    const win = getWindow()
    const result = await dialog.showOpenDialog(win ?? undefined!, {
      title: 'Choose a workspace folder',
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]!
  })

  // Cleanup on teardown.
  return () => {
    chat.cancelAll()
    for (const channel of Object.values(IPC)) ipcMain.removeHandler(channel)
  }
}
