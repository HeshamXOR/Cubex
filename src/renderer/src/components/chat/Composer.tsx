import { useEffect, useRef, useState, type ChangeEvent, type ClipboardEvent, type DragEvent } from 'react'
import {
  ArrowUp,
  Check,
  ChevronDown,
  ClipboardList,
  Eraser,
  FileText,
  FolderPlus,
  History,
  ImageIcon,
  Maximize2,
  MessagesSquare,
  Paperclip,
  Plus,
  Shield,
  ShieldOff,
  Square,
  SquarePen,
  Target,
  Wrench,
  X
} from 'lucide-react'
import { COMPOSER_MAX_LENGTH, selectableProvider, useStore } from '../../state/store'
import { useQueue } from '../../state/queue'
import { useRestore } from '../../state/restore'
import { api } from '../../lib/api'
import { registerComposer } from '../../lib/composerFocus'
import { PLACEHOLDERS, situationOf } from '../../lib/composerLayout'
import { plural } from '../../lib/format'
import { openSettingsGroup } from '../../lib/settingsLink'
import { matchesShortcut } from '../../lib/shortcuts'
import { useDensity, useFittedText } from '../../lib/useFit'
import { useMenuKeys } from '../../lib/useMenuKeys'
import { usePromptHistory } from '../../lib/usePromptHistory'
import type { DirEntry, PermissionMode } from '../../../../shared/ipc'
import { IMAGE_ATTACHMENT_MAX_BYTES, IMAGE_ATTACHMENT_MAX_COUNT, TEXT_ATTACHMENT_ACCEPT, TEXT_ATTACHMENT_MAX_BYTES, TEXT_ATTACHMENT_TOTAL_MAX_BYTES, TEXT_ATTACHMENT_MAX_FILES, isSupportedTextAttachment, decodeAttachmentText } from '../../../../shared/attachmentRules'
import { effortOptionsFor, normalizeEffortFor } from '@core/providers'
import { ContextMeter } from '../ContextMeter'
import { activitySpecFor } from '../../status/StatusIndicator'
import { slashQuery } from '../../lib/slashCommands'
import { useSkillCatalog } from '../../lib/useSkillCatalog'
import { useSkills } from '../../state/skills'
import { ProviderModelChoices } from './ProviderModelChoices'
import { SlashMenu, useSlashMenu } from './SlashMenu'
import { EffortSlider } from './EffortSlider'
import { QueueStack } from './QueueStack'

const IMAGE_ATTACHMENT_ACCEPT = 'image/png,image/jpeg,image/webp,image/gif'
/** The model popover also holds a slider, so only the model buttons take the arrow keys. */
const MODEL_ENTRIES = '.menu__scroll button'
const IMAGE_TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' }

function readAttachmentData(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '')
    reader.onerror = () => reject(new Error('This file could not be read. Select it again.'))
    reader.onabort = () => reject(new Error('Reading this file was interrupted. Select it again.'))
    reader.readAsDataURL(file)
  })
}

export const PERM_MODES: Record<PermissionMode, { label: string; icon: typeof Shield; tone: string; hint: string }> = {
  default: { label: 'Ask before edits', icon: Shield, tone: 'perm--default', hint: 'Asks before it writes files or runs commands' },
  acceptEdits: { label: 'Accept edits', icon: SquarePen, tone: 'perm--accept', hint: 'Edits files without asking; commands still ask' },
  plan: { label: 'Plan mode', icon: ClipboardList, tone: 'perm--plan', hint: 'Read-only: researches and proposes a plan' },
  bypass: { label: 'Bypass permissions', icon: ShieldOff, tone: 'perm--bypass', hint: 'Runs every tool without asking' }
}

interface ComposerProps {
  modelOpen: boolean
  setModelOpen: (open: boolean) => void
}

/** The dock's input: text, attachments, the slash and @ pickers, and the model, permission and context controls. */
export function Composer({ modelOpen, setModelOpen }: ComposerProps): JSX.Element {
  const status = useStore((s) => s.status)
  const providers = useStore((s) => s.providers)
  const settings = useStore((s) => s.settings)
  const activeProviderId = useStore((s) => s.activeProviderId)
  const activeModel = useStore((s) => s.activeModel)
  const models = useStore((s) => s.models)
  const effort = useStore((s) => s.effort)
  const setEffort = useStore((s) => s.setEffort)
  const submitComposer = useStore((s) => s.submitComposer)
  const startingRequest = useStore((s) => s.startingRequest)
  const cancel = useStore((s) => s.cancel)
  const longContext = useStore((s) => s.longContext)
  const toggleLongContext = useStore((s) => s.toggleLongContext)
  const chatPeers = useStore((s) => s.peers)
  const togglePeer = useStore((s) => s.togglePeer)
  const permissionMode = useStore((s) => s.permissionMode)
  const setPermissionMode = useStore((s) => s.setPermissionMode)
  const cyclePermissionMode = useStore((s) => s.cyclePermissionMode)
  const workspace = useStore((s) => s.activeConversation ? s.activeConversation.workspacePath : s.settings?.general.workspacePath)
  const conversationId = useStore((s) => s.activeConversation?.id)
  const pickWorkspace = useStore((s) => s.pickWorkspace)
  const attachments = useStore((s) => s.attachments)
  const addAttachment = useStore((s) => s.addAttachment)
  const removeAttachment = useStore((s) => s.removeAttachment)
  const clearAttachments = useStore((s) => s.clearAttachments)
  const setView = useStore((s) => s.setView)
  const sessionSystem = useStore((s) => s.sessionSystem)
  const sessionGoal = useStore((s) => s.sessionGoal)
  const setGoal = useStore((s) => s.setGoal)
  const contextUsage = useStore((s) => s.contextUsage)
  const lastUsage = useStore((s) => s.debug.usage)
  const text = useStore((s) => s.composerText)
  const setText = useStore((s) => s.setComposerText)
  const composerInsert = useStore((s) => s.composerInsert)
  const consumeComposerInsert = useStore((s) => s.consumeComposerInsert)
  const pendingPermission = useStore((s) => s.pendingPermission)
  const pendingQuestion = useStore((s) => s.pendingQuestion)
  const pendingPlan = useStore((s) => s.pendingPlan)
  const compactActive = useStore((s) => s.compactActive)
  const compacting = useStore((s) => !!s.activeConversation && s.compactingId === s.activeConversation.id)
  const userTurns = useStore((s) => s.liveMessages.reduce((count, message) => count + (message.role === 'user' ? 1 : 0), 0))
  const restoring = useRestore((s) => s.restoring)

  const availableProviders = providers.filter((provider) => selectableProvider(provider, settings))
  // Other agents the model may ask: those that are on in Settings, and the ones this chat turned on among them.
  const agentList = (settings?.peers?.list ?? []).filter((entry) => entry.enabled)
  const programsOff = !!settings?.privacy.localOnly
  const agentsOn = agentList.filter((entry) => chatPeers.includes(entry.id) && !(programsOff && entry.kind === 'cli'))
  const agentsLabel = agentsOn.length === 1 ? agentsOn[0]!.name : agentsOn.length === 2 ? `${agentsOn[0]!.name}, ${agentsOn[1]!.name}` : `${agentsOn.length} agents`
  const activeModelInfo = activeProviderId ? models[activeProviderId]?.find((m) => m.id === activeModel) : undefined
  const activeKind = providers.find((p) => p.id === activeProviderId)?.kind
  const effortModel = activeModelInfo ?? { id: activeModel ?? '' }
  const effortOptions = activeKind ? effortOptionsFor(activeKind, effortModel) : []
  const selectedEffort = activeKind ? normalizeEffortFor(activeKind, effort, effortModel) : undefined
  const selectedOption = effortOptions.find((option) => option.value === selectedEffort)
  const activeModelName = activeModelInfo?.displayName || activeModel || 'Select model'
  const effortLabel = selectedOption?.label ?? 'Default'

  const taRef = useRef<HTMLTextAreaElement>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  const imgInputRef = useRef<HTMLInputElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [permOpen, setPermOpen] = useState(false)
  const [plusOpen, setPlusOpen] = useState(false)
  const [confirmClear, setConfirmClear] = useState(false)
  const clearEntry = useRef<HTMLButtonElement>(null)
  const clearCancel = useRef<HTMLButtonElement>(null)
  const wasAsking = useRef(false)
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null)
  const [mFiles, setMFiles] = useState<DirEntry[]>([])
  const [mIndex, setMIndex] = useState(0)
  const [dragOver, setDragOver] = useState(false)
  const [attachmentErrors, setAttachmentErrors] = useState<string[]>([])
  const [attachmentReads, setAttachmentReads] = useState(0)
  const uploadEpoch = useRef(0)
  const plusMenu = useMenuKeys(plusOpen, () => setPlusOpen(false))
  const permMenu = useMenuKeys(permOpen, () => setPermOpen(false))
  const modelMenu = useMenuKeys(modelOpen, () => setModelOpen(false), MODEL_ENTRIES)

  useEffect(() => {
    setAttachmentErrors([])
    setAttachmentReads(0)
    setMention(null)
    uploadEpoch.current++
    return () => { uploadEpoch.current++ }
  }, [conversationId])

  // Other parts of the app put the caret in the composer (editing a queued message, restoring an earlier one).
  useEffect(() => {
    registerComposer(taRef.current)
    return () => registerComposer(null)
  }, [])
  // Clearing the history asks once; closing the menu forgets the question.
  useEffect(() => { if (!plusOpen) setConfirmClear(false) }, [plusOpen])
  // The question replaces the entry that had focus, so focus follows it onto the safe answer, and comes back on Cancel.
  useEffect(() => {
    if (confirmClear) clearCancel.current?.focus()
    else if (wasAsking.current && plusOpen) clearEntry.current?.focus()
    wasAsking.current = confirmClear
  }, [confirmClear, plusOpen])

  // Pull in @file mentions clicked elsewhere (search results, the file tree).
  useEffect(() => {
    if (!composerInsert) return
    setText((t) => (t.endsWith(' ') || t === '' ? t : `${t} `) + composerInsert)
    consumeComposerInsert()
    taRef.current?.focus()
  }, [composerInsert, consumeComposerInsert, setText])

  const perm = PERM_MODES[permissionMode]
  const busy = !!activitySpecFor(status).active || status === 'awaiting_input'
  // The figures are for the request the meter describes, so they are shown once its answer is complete.
  const lastReply = !busy && lastUsage
    ? { ...(lastUsage.outputTokens !== undefined ? { outputTokens: lastUsage.outputTokens } : {}), ...(lastUsage.reasoningTokens !== undefined ? { reasoningTokens: lastUsage.reasoningTokens } : {}) }
    : undefined
  const ready = !!activeModel && availableProviders.some((provider) => provider.id === activeProviderId)

  // @-mention autocomplete: search workspace files as the user types after "@".
  useEffect(() => {
    if (!mention || !workspace) {
      setMFiles([])
      return
    }
    let alive = true
    const timer = setTimeout(() => {
      void api.searchWorkspaceFiles(mention.query, 8, conversationId).then((files) => {
        if (alive) {
          setMFiles(files)
          setMIndex(0)
        }
      }).catch(() => { if (alive) setMFiles([]) })
    }, 60)
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [mention, workspace, conversationId])

  const onComposerChange = (e: ChangeEvent<HTMLTextAreaElement>): void => {
    const value = e.target.value
    setText(value)
    const caret = e.target.selectionStart ?? value.length
    const found = /(?:^|\s)@([^\s@]*)$/.exec(value.slice(0, caret))
    if (found && workspace) setMention({ start: caret - found[1]!.length - 1, query: found[1]! })
    else setMention(null)
  }

  const insertMention = (path: string): void => {
    if (!mention) return
    const before = text.slice(0, mention.start)
    const after = text.slice(mention.start + 1 + mention.query.length)
    setText(`${before}@${path} ${after}`)
    setMention(null)
    taRef.current?.focus()
  }
  const mentionOpen = !!mention && mFiles.length > 0

  const onFiles = async (files: FileList | File[] | null, imagesOnly = false): Promise<void> => {
    if (!files) return
    // FileList is live: resetting the picker clears it before React commits state.
    const selected = Array.from(files)
    const epoch = uploadEpoch.current
    const currentTask = (): boolean => epoch === uploadEpoch.current && useStore.getState().activeConversation?.id === conversationId
    setAttachmentErrors([])
    setAttachmentReads((count) => count + selected.length)
    for (const file of selected) {
      try {
        if (!currentTask()) return
        const extension = file.name.split('.').pop()?.toLowerCase() ?? ''
        const imageType = file.type.startsWith('image/') && file.type !== 'image/svg+xml' ? file.type : !file.type ? IMAGE_TYPES[extension] : undefined
        if (imagesOnly || imageType) {
          if (!imageType || !Object.values(IMAGE_TYPES).includes(imageType)) throw new Error('Choose a PNG, JPEG, WebP, or GIF image.')
          if (file.size > IMAGE_ATTACHMENT_MAX_BYTES) throw new Error(`Images must be ${IMAGE_ATTACHMENT_MAX_BYTES / 1024 / 1024} MB or smaller. Resize or crop it first.`)
          if (useStore.getState().attachments.filter((part) => part.type === 'image').length >= IMAGE_ATTACHMENT_MAX_COUNT) throw new Error(`Attach up to ${IMAGE_ATTACHMENT_MAX_COUNT} images per message.`)
          const data = await readAttachmentData(file)
          if (currentTask()) addAttachment({ type: 'image', source: { kind: 'base64', mediaType: imageType, data } })
          continue
        }
        if (!isSupportedTextAttachment(file.name, file.type)) throw new Error('This file format is not supported. Attach a text or code file, or paste its text. PDFs and binary documents cannot be read here.')
        if (file.size > TEXT_ATTACHMENT_MAX_BYTES) throw new Error(`Text files must be ${TEXT_ATTACHMENT_MAX_BYTES / 1024} KiB or smaller.`)
        decodeAttachmentText(new Uint8Array(await file.arrayBuffer()))
        if (!currentTask()) return
        const data = await readAttachmentData(file)
        if (!currentTask()) return
        // Check again after reading: another upload may have completed meanwhile.
        const existing = useStore.getState().attachments.filter((part) => part.type === 'file')
        if (existing.length >= TEXT_ATTACHMENT_MAX_FILES) throw new Error(`Attach up to ${TEXT_ATTACHMENT_MAX_FILES} text files per message.`)
        const existingBytes = existing.reduce((total, part) => total + (part.source.kind === 'base64' ? Math.floor(part.source.data.length * 3 / 4) - (part.source.data.endsWith('==') ? 2 : part.source.data.endsWith('=') ? 1 : 0) : 0), 0)
        if (existingBytes + file.size > TEXT_ATTACHMENT_TOTAL_MAX_BYTES) throw new Error(`Keep text attachments under ${TEXT_ATTACHMENT_TOTAL_MAX_BYTES / 1024 / 1024} MiB in total.`)
        addAttachment({ type: 'file', source: { kind: 'base64', mediaType: file.type || 'text/plain', data }, filename: file.name })
      } catch (cause) {
        if (currentTask()) setAttachmentErrors((errors) => [...errors, `${file.name}: ${cause instanceof Error ? cause.message : 'Could not attach this file.'}`])
      } finally {
        if (currentTask()) setAttachmentReads((count) => Math.max(0, count - 1))
      }
    }
  }

  // Paste an image straight into the composer (Ctrl/Cmd+V).
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>): void => {
    const items = e.clipboardData?.items
    if (!items) return
    const images: File[] = []
    for (const item of Array.from(items)) {
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        const file = item.getAsFile()
        if (file) images.push(file)
      }
    }
    if (images.length) {
      e.preventDefault()
      void onFiles(images, true)
    }
  }

  // Drag-and-drop files and images onto the composer.
  const onDrop = (e: DragEvent<HTMLDivElement>): void => {
    e.preventDefault()
    setDragOver(false)
    const files = Array.from(e.dataTransfer?.files ?? [])
    if (files.length) void onFiles(files)
  }

  // Auto-grow the textarea.
  useEffect(() => {
    const ta = taRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = `${Math.min(ta.scrollHeight, 220)}px`
  }, [text])

  const { skills: skillList, loading: skillsLoading, refresh: refreshSkills } = useSkillCatalog(conversationId, workspace)
  const slash = useSlashMenu({ text, setText, skills: skillList, loading: skillsLoading, focusField: () => taRef.current?.focus() })
  // A slash that starts the message reads the list again, so a skill added a moment ago shows up.
  const slashStarted = slashQuery(text) !== undefined
  useEffect(() => { if (slashStarted) refreshSkills() }, [slashStarted, refreshSkills])
  // A skill that could not be applied is explained until the message changes.
  const skillFailure = useSkills((s) => (conversationId ? s.failures[conversationId] : undefined))
  useEffect(() => { if (conversationId) useSkills.getState().clearFailure(conversationId) }, [text, conversationId])
  const history = usePromptHistory(workspace, conversationId, text, setText)

  // While a turn runs, a summary is written or a request is starting, Enter queues the message for when that is done.
  const queueing = busy || compacting || startingRequest
  const canSend = !!text.trim() && !restoring && attachmentReads === 0 && (queueing ? !!conversationId : ready || text.trim().startsWith('/'))

  const submit = (): void => {
    if (!canSend) return
    if (queueing) {
      if (!conversationId || !useQueue.getState().add(conversationId, { text, attachments })) return
      history.record(text)
      setText('')
      clearAttachments()
      return
    }
    history.record(text)
    void submitComposer()
  }

  const situation = situationOf({
    ready,
    hasProviders: availableProviders.length > 0,
    localOnly: !!settings?.privacy.localOnly,
    compacting,
    asking: !!(pendingPermission || pendingQuestion),
    planning: !!pendingPlan,
    working: busy
  })
  const placeholder = useFittedText(taRef, PLACEHOLDERS[situation])
  const density = useDensity(boxRef)
  const compactBlockedReason = busy ? 'Available when the current turn finishes.'
    : compacting ? 'Summarizing now.'
      : userTurns < 3 ? 'There are too few messages to summarize yet.' : undefined

  return (
    <div className="composer" data-density={density}>
      {slash.open && <SlashMenu menu={slash} />}
      {mentionOpen && (
        <div className="palette mention" role="listbox" aria-label="Files in project">
          <div className="palette__label">Files in project</div>
          {mFiles.map((file, index) => (
            <button key={file.path} className={`palette__item ${index === mIndex ? 'palette__item--sel' : ''}`} role="option" aria-selected={index === mIndex} onMouseEnter={() => setMIndex(index)} onClick={() => insertMention(file.path)}>
              <FileText size={14} className="mention__icon" />
              <span className="mention__name">{file.name}</span>
              <span className="mention__path">{file.path}</span>
            </button>
          ))}
        </div>
      )}

      {sessionGoal && (
        <div className="banner banner--goal">
          <Target size={13} />
          <span className="banner__text"><b>Goal</b> {sessionGoal}</span>
          <button className="banner__x" onClick={() => setGoal(undefined)} aria-label="Clear goal" title="Clear goal"><X size={13} /></button>
        </div>
      )}
      {sessionSystem && (
        <div className="banner" title={sessionSystem}>
          <Wrench size={13} />
          <span className="banner__text"><b>System</b> {sessionSystem.slice(0, 80)}{sessionSystem.length > 80 ? '…' : ''}</span>
        </div>
      )}

      <QueueStack conversationId={conversationId} />

      {attachmentErrors.length > 0 && (
        <div className="attachment-errors" role="alert">
          <div>{attachmentErrors.map((error, index) => <p key={index}>{error}</p>)}</div>
          <button onClick={() => setAttachmentErrors([])} aria-label="Dismiss attachment errors"><X size={14} /></button>
        </div>
      )}
      {attachmentReads > 0 && <div className="attachment-reading" role="status">Preparing {attachmentReads === 1 ? 'attachment' : `${attachmentReads} attachments`}…</div>}
      {skillFailure && conversationId && (
        <div className="callout callout--error composer__failure" role="alert">
          <div className="callout__body">{skillFailure}</div>
          <button className="callout__icon" onClick={() => useSkills.getState().clearFailure(conversationId)} aria-label="Dismiss this message" title="Dismiss"><X size={14} aria-hidden="true" /></button>
        </div>
      )}
      <input ref={imgInputRef} type="file" accept={IMAGE_ATTACHMENT_ACCEPT} multiple hidden onChange={(e) => { void onFiles(e.target.files, true); e.target.value = '' }} />
      <input ref={fileInputRef} type="file" accept={TEXT_ATTACHMENT_ACCEPT} multiple hidden onChange={(e) => { void onFiles(e.target.files); e.target.value = '' }} />

      <div
        ref={boxRef}
        className={`cbox ${dragOver ? 'cbox--drag' : ''}`}
        onDragOver={(e) => {
          if (e.dataTransfer?.types?.includes('Files')) {
            e.preventDefault()
            setDragOver(true)
          }
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
      >
        {attachments.length > 0 && (
          <div className="attachrow">
            {attachments.map((attachment, index) => (
              <span className="attachchip" key={index}>
                {attachment.type === 'image' && attachment.source.kind === 'base64'
                  ? <img src={`data:${attachment.source.mediaType};base64,${attachment.source.data}`} alt="" />
                  : <FileText size={14} />}
                <span className="attachchip__name" title={attachment.type === 'file' ? attachment.filename : undefined}>{attachment.type === 'file' ? attachment.filename ?? 'file' : attachment.type === 'image' ? 'image' : attachment.type}</span>
                <button className="attachchip__x" onClick={() => removeAttachment(index)} aria-label={`Remove ${attachment.type === 'file' ? attachment.filename ?? 'file' : 'image'}`} title="Remove attachment"><X size={12} /></button>
              </span>
            ))}
          </div>
        )}

        {history.position > 0 && (
          <div className="chint" role="status">
            <History size={12} aria-hidden="true" />
            <span className="chint__what">Prompt {history.position} of {history.count}</span>
            <span className="chint__keys">Esc returns to your draft</span>
          </div>
        )}

        <textarea
          ref={taRef}
          className="cph"
          rows={1}
          value={text}
          maxLength={COMPOSER_MAX_LENGTH}
          aria-label="Message"
          aria-controls={slash.open ? slash.listboxId : undefined}
          aria-activedescendant={slash.activeId}
          aria-autocomplete={slash.open ? 'list' : undefined}
          onFocus={slash.onFocus}
          onBlur={slash.onBlur}
          onChange={onComposerChange}
          onPaste={onPaste}
          onKeyDown={(e) => {
            if (mentionOpen) {
              if (e.key === 'ArrowDown') { e.preventDefault(); setMIndex((i) => (i + 1) % mFiles.length); return }
              if (e.key === 'ArrowUp') { e.preventDefault(); setMIndex((i) => (i - 1 + mFiles.length) % mFiles.length); return }
              if (e.key === 'Enter' || matchesShortcut(e, 'complete')) { e.preventDefault(); insertMention(mFiles[mIndex]!.path); return }
              if (e.key === 'Escape') { e.preventDefault(); setMention(null); return }
            }
            // The "/" menu takes the arrow keys, Enter, Tab and Esc while it is open.
            if (slash.onKeyDown(e)) return
            if (e.nativeEvent.isComposing) return
            // Up and Down walk through earlier prompts only where the caret would have nowhere else to go.
            if (matchesShortcut(e, 'older') && history.older(e.currentTarget)) { e.preventDefault(); return }
            if (matchesShortcut(e, 'newer') && history.newer(e.currentTarget)) { e.preventDefault(); return }
            if (matchesShortcut(e, 'draft') && history.leave()) { e.preventDefault(); return }
            if (matchesShortcut(e, 'mode')) { e.preventDefault(); cyclePermissionMode(); return }
            // The browser inserts the line break itself.
            if (matchesShortcut(e, 'newline')) return
            if (matchesShortcut(e, 'send')) {
              e.preventDefault()
              submit()
            }
          }}
          placeholder={placeholder}
        />

        <div className="cbar">
          <div className="pos-rel">
            <button ref={plusMenu.triggerRef} className={`cb icon ${plusOpen ? 'is-open' : ''}`} onClick={() => setPlusOpen((v) => !v)} aria-label="Add context and tools" aria-haspopup="menu" aria-expanded={plusOpen} title="Add context and tools">
              <Plus size={16} />
            </button>
            {plusOpen && (
              <>
                <div className="backdrop" onClick={() => setPlusOpen(false)} />
                <div ref={plusMenu.menuRef} className="menu menu--up" role="menu" tabIndex={-1} onKeyDown={plusMenu.onKeyDown} style={{ left: 0, minWidth: 250 }}>
                  <div className="menu__label">Add</div>
                  <button className="menu__item" role="menuitem" title="UTF-8 text and source files, 256 KiB each" onClick={() => { fileInputRef.current?.click(); setPlusOpen(false) }}>
                    <Paperclip size={15} /><span className="menu__t">Attach text or code</span>
                  </button>
                  <button className="menu__item" role="menuitem" onClick={() => { imgInputRef.current?.click(); setPlusOpen(false) }}>
                    <ImageIcon size={15} /><span className="menu__t">Attach image</span>
                  </button>
                  {activeModelInfo?.longContextBeta && (
                    <>
                      <div className="menu__sep" />
                      <div className="menu__label">Tools</div>
                      <button className="menu__item menu__item--toggle" role="menuitemcheckbox" aria-checked={longContext} onClick={toggleLongContext}>
                        <Maximize2 size={15} /><span className="menu__t">1M context</span>
                        <span className={`switchdot ${longContext ? 'on' : ''}`} />
                      </button>
                    </>
                  )}
                  <div className="menu__sep" />
                  <div className="menu__label">Other agents</div>
                  {agentList.length === 0 ? (
                    <button className="menu__item" role="menuitem" onClick={() => { setPlusOpen(false); openSettingsGroup('agents') }}>
                      <MessagesSquare size={15} />
                      <span>
                        <span className="menu__t">Set up other agents</span>
                        <span className="menu__s">Let the model ask Claude Code or another model.</span>
                      </span>
                    </button>
                  ) : agentList.map((entry) => {
                    const blocked = programsOff && entry.kind === 'cli'
                    const on = chatPeers.includes(entry.id) && !blocked
                    return (
                      <button key={entry.id} className="menu__item menu__item--toggle" role="menuitemcheckbox" aria-checked={on} aria-disabled={blocked || undefined} onClick={() => { if (!blocked) togglePeer(entry.id) }}>
                        <MessagesSquare size={15} />
                        <span>
                          <span className="menu__t">{entry.name}</span>
                          <span className="menu__s">{blocked ? 'Off in local-only mode' : entry.kind === 'cli' ? 'Program on this computer' : 'Model'}</span>
                        </span>
                        <span className={`switchdot ${on ? 'on' : ''}`} />
                      </button>
                    )
                  })}
                  <div className="menu__sep" />
                  <div className="menu__label">Prompt history</div>
                  {history.count === 0 ? (
                    <div className="menu__model-note">Prompts you send are saved here for each project. Press Up in the composer to bring one back.</div>
                  ) : confirmClear ? (
                    <div className="menu__confirm" role="group" aria-label="Clear prompt history">
                      <span className="menu__s">Clear {plural(history.count, 'saved prompt')}?</span>
                      <span className="menu__confirm-actions">
                        <button ref={clearCancel} className="btn ghost sm" role="menuitem" onClick={() => setConfirmClear(false)}>Cancel</button>
                        <button className="btn btn--danger sm" role="menuitem" onClick={() => { history.clear(); setPlusOpen(false) }}>Clear</button>
                      </span>
                    </div>
                  ) : (
                    <button ref={clearEntry} className="menu__item" role="menuitem" onClick={() => setConfirmClear(true)}>
                      <Eraser size={15} />
                      <span>
                        <span className="menu__t">Clear prompt history</span>
                        <span className="menu__s">{plural(history.count, 'prompt')} saved{workspace ? ' for this project' : ''}</span>
                      </span>
                    </button>
                  )}
                </div>
              </>
            )}
          </div>

          <div className="pos-rel">
            <button ref={permMenu.triggerRef} className={`cb perm ${perm.tone} ${permOpen ? 'is-open' : ''}`} onClick={() => setPermOpen((v) => !v)} aria-haspopup="menu" aria-expanded={permOpen} title={`${perm.hint}. Shift+Tab cycles the mode.`}>
              <perm.icon size={14} />
              <span className="cb__label">{perm.label}</span>
              <ChevronDown size={13} />
            </button>
            {permOpen && (
              <>
                <div className="backdrop" onClick={() => setPermOpen(false)} />
                <div ref={permMenu.menuRef} className="menu menu--up" role="menu" tabIndex={-1} onKeyDown={permMenu.onKeyDown} style={{ left: 0, minWidth: 270 }}>
                  <div className="menu__label">Permissions, Shift+Tab to cycle</div>
                  {(Object.keys(PERM_MODES) as PermissionMode[]).map((mode) => {
                    const meta = PERM_MODES[mode]
                    return (
                      <button key={mode} className={`menu__item ${permissionMode === mode ? 'menu__item--sel' : ''}`} role="menuitemradio" aria-checked={permissionMode === mode} onClick={() => { setPermissionMode(mode); setPermOpen(false) }}>
                        <meta.icon size={15} />
                        <span>
                          <span className="menu__t">{meta.label}</span>
                          <span className="menu__s">{meta.hint}</span>
                        </span>
                        {permissionMode === mode && <Check size={15} className="menu__check" />}
                      </button>
                    )
                  })}
                </div>
              </>
            )}
          </div>

          {agentsOn.length > 0 && (
            <button className="cb" onClick={() => setPlusOpen(true)} title="Other agents the model may ask in this chat. Click to change." aria-label={`Other agents in this chat: ${agentsLabel}. Change`}>
              <MessagesSquare size={14} /><span className="cb__label">{agentsLabel}</span>
            </button>
          )}

          {!workspace && (
            <button className="cb" onClick={() => void pickWorkspace()} title="Choose a project folder for Cubex to read and edit">
              <FolderPlus size={14} /><span className="cb__label">Add folder</span>
            </button>
          )}

          <span className="grow" />

          <div className="pos-rel cb-model">
            <button
              ref={modelMenu.triggerRef}
              className={`cb ${modelOpen ? 'is-open' : ''}`}
              onClick={() => setModelOpen(!modelOpen)}
              aria-haspopup="dialog"
              aria-expanded={modelOpen}
              aria-label={effortOptions.length ? `${activeModelName} ${effortLabel}. Choose model and effort` : `${activeModelName}. Choose model`}
              title={effortOptions.length ? `${activeModelName}, ${effortLabel} effort. Choose model and effort.` : `${activeModelName}. Choose model.`}
            >
              <span className="cb__label">{activeModelName}</span>
              {effortOptions.length > 0 && <>{' '}<span className="eff">{effortLabel}</span></>}
              <ChevronDown size={13} />
            </button>
            {modelOpen && (
              <>
                <div className="backdrop" onClick={() => setModelOpen(false)} />
                <div ref={modelMenu.menuRef} className="menu menu--up menu--models" role="dialog" aria-label="Model and reasoning effort" tabIndex={-1} onKeyDown={modelMenu.onKeyDown} style={{ right: 0 }}>
                  {effortOptions.length > 0 && (
                    <div className="effort">
                      <EffortSlider options={effortOptions} selected={selectedEffort} onChange={setEffort} />
                      <div className="menu__sep" />
                    </div>
                  )}
                  <div className="menu__scroll">
                    {availableProviders.length === 0 && (
                      <>
                        <div className="menu__label">{settings?.privacy.localOnly ? 'Local-only mode is on. No local providers are enabled.' : 'No providers are enabled.'}</div>
                        <button className="menu__item" onClick={() => { setModelOpen(false); setView('providers') }}>
                          <Plus size={15} aria-hidden="true" /><span className="menu__t">Manage providers</span>
                        </button>
                      </>
                    )}
                    {availableProviders.map((provider) => <ProviderModelChoices key={provider.id} provider={provider} onSelect={() => setModelOpen(false)} />)}
                  </div>
                </div>
              </>
            )}
          </div>

          <ContextMeter
            key={conversationId ?? 'new'}
            usage={contextUsage}
            contextWindow={activeModelInfo?.contextWindow}
            lastReply={lastReply}
            onCompact={conversationId ? () => void compactActive() : undefined}
            compactBlockedReason={compactBlockedReason}
          />

          {busy ? (
            <button className="send send--stop" onClick={cancel} aria-label="Stop" title={pendingPermission || pendingQuestion || pendingPlan ? 'Stop' : 'Stop. Esc also stops.'}>
              <Square size={13} fill="currentColor" strokeWidth={0} />
            </button>
          ) : (
            <button className="send" onClick={submit} disabled={!canSend} aria-label={queueing ? 'Queue message' : 'Send'} title={attachmentReads > 0 ? 'Preparing attachments' : restoring ? 'Restoring an earlier point' : queueing ? 'Queue message, Enter' : 'Send, Enter'}>
              <ArrowUp size={16} strokeWidth={2.2} />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
