import { dialog, ipcMain, shell, type BrowserWindow } from 'electron'
import { nanoid } from 'nanoid'
import {
  IPC,
  type ChatEvent,
  type Conversation,
  type PermissionDecision,
  type PlanDecision,
  type PullProgress
} from '@shared/ipc'
import { parseProviderConfig, parseProviderId, parseSecret } from './providerInput'
import type { BenchmarkResult } from '@core/types'
import { conversationRepo, presetRepo, providerRepo, usageRepo } from './db'
import { deleteSecret, setSecret } from './credentials'
import { getSettings, updateSettings } from './config'
import { recentLogs } from './logger'
import { ProviderManager } from './ProviderManager'
import { sharedModelCatalog } from './modelCatalog'
import { ChatService } from './ChatService'
import { LocalService } from './LocalService'
import { exportConversation, importConversation } from './exporter'
import { validatePlanResolution } from './plans'
import { readWorkspaceDirectory, resolveWorkspacePath, searchWorkspaceEntries, selectWorkspace } from './workspaceFiles'
import { loadSkills, readSkill, type Skill } from './skills'
import { validateRevertPaths } from './sessionChanges'
import { parsePermissionDecision, parseRuleId, parseWorkspaceFilter } from './permissionRules'
import { GitStatusReader } from './gitStatus'
import { commitChanges, parseGitCommitRequest, suggestCommitMessage } from './gitCommit'
import type { GitCommitResult } from '@shared/ipc'
import type { CompactionResult } from '@shared/ipc'
import { listShells } from './shell/shellProvider'
import { registerIpcModules } from './ipcModules'


/**
 * Registers all IPC handlers. Each maps a channel to a service method. The
 * renderer never touches Node APIs directly — everything flows through here.
 */
export function registerIpc(getWindow: () => BrowserWindow | null): { dispose: () => void; cancelChats: () => void } {
  const providers = new ProviderManager({ catalog: sharedModelCatalog() })

  const send = (channel: string, payload: unknown): void => {
    const window = getWindow()
    if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send(channel, payload)
  }

  // Main-process features (notifications, for one) observe the same events the window gets.
  const chatListeners = new Set<(event: ChatEvent) => void>()
  const onChatEvent = (listener: (event: ChatEvent) => void): (() => void) => {
    chatListeners.add(listener)
    return () => { chatListeners.delete(listener) }
  }
  const chat = new ChatService(providers, (e: ChatEvent) => {
    send(IPC.chatEvent, e)
    for (const listener of chatListeners) {
      try { listener(e) } catch { /* an observer must never break a turn */ }
    }
  })
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
  handle(IPC.saveProvider, async (input: unknown, secretInput?: unknown) => {
    const cfg = parseProviderConfig(input)
    const secret = parseSecret(secretInput)
    // A stored key belongs to one provider: the window cannot point this provider at another one's key.
    const current = providerRepo.get(cfg.id)
    if (cfg.credentialRef && cfg.credentialRef !== current?.credentialRef && providerRepo.list().some((other) => other.id !== cfg.id && other.credentialRef === cfg.credentialRef)) {
      throw new Error('That stored key belongs to another provider.')
    }
    if (secret) {
      const ref = cfg.credentialRef ?? `cred_${cfg.id}_${nanoid(6)}`
      const res = setSecret(ref, secret)
      // Don't report success while silently dropping the key: if the OS
      // credential store is unavailable we refuse plaintext, so surface it.
      if (!res.ok) {
        throw new Error(
          res.message ??
            'Could not securely store the API key: OS encryption is unavailable on this system.'
        )
      }
      cfg.credentialRef = ref
    }
    providerRepo.save(cfg)
    providers.invalidate(cfg.id)
    return cfg
  })
  handle(IPC.deleteProvider, (idInput: unknown) => {
    const id = parseProviderId(idInput)
    const cfg = providerRepo.get(id)
    if (cfg?.credentialRef) deleteSecret(cfg.credentialRef)
    providerRepo.delete(id)
    providers.invalidate(id)
  })
  handle(IPC.testProvider, (id: unknown) => providers.test(parseProviderId(id)))
  handle(IPC.listModels, (providerId: unknown) => providers.listModels(parseProviderId(providerId)))

  // Resolve a named discovered skill; renderer inputs can never supply a file path.
  const skillWorkspace = (conversationId?: string): string | undefined =>
    selectWorkspace(getSettings().general.workspacePath, conversationId, (id) => conversationRepo.get(id))
  const skillSummary = (skill: Skill) => ({
    name: skill.name, description: skill.description, source: skill.source, path: skill.filePath
  })
  handle(IPC.listSkills, (conversationId?: string) => loadSkills(skillWorkspace(conversationId)).map(skillSummary))
  handle(IPC.readSkill, (name: string, conversationId?: string) => {
    if (typeof name !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(name)) {
      throw new Error('Invalid skill name.')
    }
    const skill = loadSkills(skillWorkspace(conversationId)).find((entry) => entry.name.toLowerCase() === name.toLowerCase())
    if (!skill) throw new Error(`Skill "${name}" was not found in this library.`)
    return { ...skillSummary(skill), content: readSkill(skill) }
  })

  // --- Chat ---
  handle(IPC.startChat, (req: Parameters<ChatService['start']>[0]) => chat.start(req))
  handle(IPC.cancelChat, (streamId: string) => chat.cancel(streamId))
  // Renderer input is untrusted: the decision is one of three words, ids and the workspace filter are bounded strings.
  handle(IPC.resolvePermission, (id: string, decision: PermissionDecision) =>
    chat.resolvePermission(parseRuleId(id, 'permission id'), parsePermissionDecision(decision))
  )
  handle(IPC.listPermissionRules, (workspace?: string) => chat.listPermissionRules(parseWorkspaceFilter(workspace)))
  handle(IPC.removePermissionRule, (id: string) => chat.removePermissionRule(parseRuleId(id, 'rule id')))
  handle(IPC.rewindFiles, (conversationId: string, messageId: string) => chat.rewindFiles(conversationId, messageId))
  handle(IPC.resolveQuestion, (id: string, answers: string[]) => chat.resolveQuestion(id, answers))
  handle(IPC.resolvePlan, (id: string, decision: PlanDecision, feedback?: string) => {
    const resolution = validatePlanResolution(decision, feedback)
    if (typeof id !== 'string' || id.length > 128) throw new Error('Invalid plan id.')
    chat.resolvePlan(id, resolution.decision, resolution.feedback)
  })
  handle(IPC.listPlans, (conversationId: string) => chat.listPlans(conversationId))
  handle(IPC.getPlan, (id: string) => chat.getPlan(id))
  handle(IPC.revealPlan, (id: string) => {
    const plan = chat.getPlan(id)
    if (!plan?.path) throw new Error('Plan artifact was not found.')
    shell.showItemInFolder(plan.path)
  })
  handle(IPC.readCommandOutput, (conversationId: string, id: string, offset?: number, limit?: number) =>
    chat.readCommandOutput(conversationId, id, offset, limit)
  )
  handle(IPC.revealCommandOutput, (conversationId: string, id: string) =>
    shell.showItemInFolder(chat.commandOutputPath(conversationId, id))
  )

  // Review panel: net file changes a task made, and undo. Renderer input is untrusted:
  // the task id is a bounded string and paths a bounded list of workspace-relative strings.
  const taskIdArg = (value: unknown): string => {
    if (typeof value !== 'string' || !value.trim() || value.length > 256) throw new Error('Invalid task id.')
    return value
  }
  handle(IPC.getSessionChanges, (conversationId: string) => chat.getSessionChanges(taskIdArg(conversationId)))
  handle(IPC.revertSessionChanges, (conversationId: string, paths?: string[]) =>
    chat.revertSessionChanges(taskIdArg(conversationId), validateRevertPaths(paths))
  )

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
      ...(partial.presetId ? { presetId: partial.presetId } : {}),
      ...(partial.composer ? { composer: partial.composer } : {}),
      ...(partial.workspacePath ? { workspacePath: partial.workspacePath } : {})
    }
    conversationRepo.create(conv)
    return conv
  })
  handle(IPC.updateConversation, (id: string, patch: Partial<Conversation>) =>
    conversationRepo.update(id, patch)
  )
  // Never rejects: a refusal (turn running, nothing to compact, summary failed) is an error result the UI can show.
  handle(IPC.compactConversation, async (conversationId: string): Promise<CompactionResult> => {
    try {
      return await chat.compactConversation(taskIdArg(conversationId))
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
  handle(IPC.deleteConversation, (id: string) => {
    conversationRepo.delete(id)
    chat.forgetConversation(id)
  })
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
  // Local runtimes (Ollama/LM Studio/llama.cpp) are external servers the app
  // connects to rather than spawns, so these report current reachability. Guard
  // the not-found case so the renderer never receives `undefined` typed as a
  // RuntimeStatus (which would throw on property access).
  handle(IPC.startRuntime, async (id: string) => {
    const status = (await local.listRuntimes()).find((x) => x.id === id)
    if (!status) throw new Error(`Unknown runtime: ${id}`)
    return status
  })
  handle(IPC.stopRuntime, async (id: string) => {
    const status = (await local.listRuntimes()).find((x) => x.id === id)
    if (!status) throw new Error(`Unknown runtime: ${id}`)
    return status
  })
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

  const taskWorkspace = (conversationId?: string): string | undefined =>
    selectWorkspace(getSettings().general.workspacePath, conversationId, (id) => conversationRepo.get(id))
  handle(IPC.readWorkspaceDir, (relPath: string, conversationId?: string) =>
    readWorkspaceDirectory(taskWorkspace(conversationId), relPath))
  handle(IPC.revealPath, (relPath: string, conversationId?: string) => {
    shell.showItemInFolder(resolveWorkspacePath(taskWorkspace(conversationId), relPath))
  })
  handle(IPC.searchWorkspaceFiles, (query: string, limit = 50, conversationId?: string) =>
    searchWorkspaceEntries(taskWorkspace(conversationId), query, limit))
  // Title-bar branch chip. selectWorkspace validates the id; the reader caches ~2 s per folder.
  const gitStatus = new GitStatusReader()
  handle(IPC.getGitStatus, (conversationId?: string) => gitStatus.read(taskWorkspace(conversationId)))
  // Review panel commit. The request is untrusted: parseGitCommitRequest bounds the message and the path
  // list, and commitChanges resolves every path against this task's workspace before git runs.
  handle(IPC.gitCommit, async (conversationId: string, request: unknown): Promise<GitCommitResult> => {
    const id = taskIdArg(conversationId)
    const parsed = parseGitCommitRequest(request)
    if (!parsed.ok) return parsed
    let workspace: string | undefined
    try { workspace = taskWorkspace(id) } catch (error) { return { ok: false, error: error instanceof Error ? error.message : 'Task was not found.' } }
    const outcome = await commitChanges(workspace, parsed.value)
    return outcome.ok ? { ok: true, commit: outcome.commit, summary: outcome.summary } : outcome
  })
  handle(IPC.gitSuggestMessage, async (conversationId: string) =>
    suggestCommitMessage(await chat.getSessionChanges(taskIdArg(conversationId))))

  // --- Shell & background tasks ---
  handle(IPC.shellList, () => listShells())
  handle(IPC.tasksList, (conversationId?: string) => {
    const cid = conversationId ? taskIdArg(conversationId) : undefined
    return chat.processManager.list(cid)
  })
  handle(IPC.tasksStop, (taskId: string) => {
    if (typeof taskId !== 'string' || !taskId.trim() || taskId.length > 64) {
      return { ok: false, error: 'Invalid task id.' }
    }
    return chat.processManager.stop(taskId.trim())
  })
  handle(IPC.tasksInput, (taskId: string, input: string) => {
    if (typeof taskId !== 'string' || !taskId.trim() || taskId.length > 64) {
      return { ok: false, error: 'Invalid task id.' }
    }
    if (typeof input !== 'string') {
      return { ok: false, error: 'Invalid task input: expected a string.' }
    }
    return chat.processManager.sendInput(taskId.trim(), input)
  })

  // Feature handlers live in src/main/ipcModules/*.ts and register themselves.
  const moduleCleanups = registerIpcModules({ handle, send, onChatEvent, getWindow, chat, local, providers, taskIdArg, taskWorkspace })

  // Cleanup on teardown.
  return {
    dispose: () => {
      // `dispose` aborts live turns itself and kills children synchronously;
      // `cancelAll` here would clear the task map first and leave the kills
      // half-done once Electron exits.
      chat.dispose()
      for (const cleanup of moduleCleanups) cleanup()
      for (const channel of Object.values(IPC)) ipcMain.removeHandler(channel)
    },
    cancelChats: () => chat.cancelAll()
  }
}
