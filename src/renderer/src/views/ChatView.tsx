import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import { ArrowDown, History } from 'lucide-react'
import { selectableProvider, useStore, type LiveMessage } from '../state/store'
import { useContextCost } from '../state/contextCost'
import { basename } from '../lib/format'
import { matchesShortcut } from '../lib/shortcuts'
import { useStickToBottom } from '../lib/useStickToBottom'
import { QuestionCard } from '../components/QuestionCard'
import { PlanCard } from '../components/PlanCard'
import { ConversationHeader } from '../components/chat/ConversationHeader'
import { AssistantRow } from '../components/chat/AssistantRow'
import { Composer } from '../components/chat/Composer'
import { ContextDivider } from '../components/chat/ContextDivider'
import { ContextNotices } from '../components/chat/ContextNotices'
import { PermissionCard } from '../components/chat/PermissionCard'
import { RestoreNotice } from '../components/chat/RestoreNotice'
import { UserRow } from '../components/chat/UserRow'
import { activitySpecFor } from '../status/StatusIndicator'
import { CubexMark } from '../theme/Logo'
import '../components/chat/chat.css'

function findLastAssistantId(messages: readonly LiveMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message?.role === 'assistant') return message.id
  }
  return undefined
}

function findLastUserId(messages: readonly LiveMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message?.role === 'user') return message.id
  }
  return undefined
}

export function ChatView(): JSX.Element {
  const messages = useStore((s) => s.liveMessages)
  const status = useStore((s) => s.status)
  const genStartedAt = useStore((s) => s.genStartedAt)
  const statusDetail = useStore((s) => s.statusDetail)
  const activeProviderId = useStore((s) => s.activeProviderId)
  const activeModel = useStore((s) => s.activeModel)
  const providers = useStore((s) => s.providers)
  const settings = useStore((s) => s.settings)
  const cancel = useStore((s) => s.cancel)
  const regenerate = useStore((s) => s.regenerate)
  const workspace = useStore((s) => (s.activeConversation ? s.activeConversation.workspacePath : s.settings?.general.workspacePath))
  const conversationId = useStore((s) => s.activeConversation?.id)
  const contextStartMessageId = useStore((s) => s.activeConversation?.contextStartMessageId)
  const contextSummary = useStore((s) => s.activeConversation?.contextSummary)
  const restoreFullContext = useStore((s) => s.restoreFullContext)
  const summaryStats = useContextCost((s) => (conversationId ? s.byConversation[conversationId]?.stats : undefined))
  const pendingPermission = useStore((s) => s.pendingPermission)
  const resolvePermission = useStore((s) => s.resolvePermission)
  const pendingQuestion = useStore((s) => s.pendingQuestion)
  const resolveQuestion = useStore((s) => s.resolveQuestion)
  const pendingPlan = useStore((s) => s.pendingPlan)
  const planLoadError = useStore((s) => s.planLoadError)
  const loadPlans = useStore((s) => s.loadPlans)
  const openPlan = useStore((s) => s.openPlan)
  const setView = useStore((s) => s.setView)

  const availableProviders = providers.filter((provider) => selectableProvider(provider, settings))
  const scrollRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const { atBottom, scrollToBottom } = useStickToBottom(scrollRef, contentRef, conversationId)
  const [modelOpen, setModelOpen] = useState(false)
  const [copiedId, setCopiedId] = useState<string | null>(null)

  const busy = !!activitySpecFor(status).active || status === 'awaiting_input'
  const ready = !!activeModel && availableProviders.some((provider) => provider.id === activeProviderId)
  const contextBoundary = contextStartMessageId ? messages.findIndex((message) => message.id === contextStartMessageId) : -1
  const contextShortened = contextBoundary > 0
  const lastAssistantId = findLastAssistantId(messages)
  const lastUserId = findLastUserId(messages)

  // Esc interrupts an in-flight generation (Claude Code parity). While something asks for
  // the person, Esc belongs to that question instead.
  useEffect(() => {
    if (!busy || pendingPlan || pendingQuestion || pendingPermission) return
    const onKey = (e: KeyboardEvent): void => {
      if (matchesShortcut(e, 'stop') && !e.defaultPrevented) cancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, cancel, pendingPlan, pendingQuestion, pendingPermission])

  // Stable, so finished rows keep receiving identical props while another turn streams.
  const copyMessage = useCallback((id: string, text: string): void => {
    void navigator.clipboard.writeText(text)
    setCopiedId(id)
    setTimeout(() => setCopiedId((current) => (current === id ? null : current)), 1500)
  }, [])
  const regenerateReply = useCallback((): void => { void regenerate() }, [regenerate])

  const workspaceName = workspace ? basename(workspace) : undefined

  return (
    <div className="chat">
      <ConversationHeader />

      <div className="stage">
        <div className="scroll" ref={scrollRef}>
          <div className={`scroll__inner ${messages.length === 0 ? 'scroll__inner--empty' : ''}`} ref={contentRef}>
            {messages.length === 0 ? (
              <div className="empty chat-enter" key={`empty:${conversationId ?? 'new'}`}>
                <CubexMark size={28} className="empty__mark" />
                <h1>What should we work on?</h1>
                <p>
                  {workspaceName
                    ? <>Cubex reads and edits files in <b>{workspaceName}</b> and runs commands there.</>
                    : 'Ask anything, or add a project folder so Cubex can read and edit its files.'}
                </p>
                <ul className="empty__keys">
                  <li><kbd>@</kbd>add a file</li>
                  <li><kbd>/</kbd>run a command or skill</li>
                  <li><kbd>Shift</kbd><kbd>Tab</kbd>change permissions</li>
                </ul>
                {!ready && (
                  <div className="empty__setup">
                    {availableProviders.length > 0 ? <>
                      Choose a model to start.{' '}
                      <button onClick={() => setModelOpen(true)}>Select model</button>
                    </> : <>
                      {settings?.privacy.localOnly ? 'Local-only mode is on. Add or enable a local provider to start.' : providers.length ? 'No providers are enabled.' : 'Add a provider to start a conversation.'}{' '}
                      <button onClick={() => setView('providers')}>Manage providers</button>
                    </>}
                  </div>
                )}
              </div>
            ) : (
              <div className="col thread chat-enter" key={`thread:${conversationId ?? 'new'}`}>
                {messages.map((m, index) => {
                  // Messages above the divider are still shown, but the model no longer sees them.
                  const outside = contextShortened && index < contextBoundary ? ' is-outside' : ''
                  return (
                  <Fragment key={m.id}>
                    {contextShortened && m.id === contextStartMessageId && (
                      <ContextDivider
                        summary={contextSummary}
                        messagesAbove={contextBoundary}
                        stats={summaryStats?.boundaryMessageId === contextStartMessageId ? summaryStats : undefined}
                        busy={busy}
                        onRestore={restoreFullContext}
                      />
                    )}

                    {m.role === 'user' ? (
                      <UserRow message={m} outside={!!outside} />
                    ) : (
                      <AssistantRow
                        message={m}
                        outside={!!outside}
                        status={m.streaming ? status : 'idle'}
                        waitingTool={m.streaming ? pendingPermission?.toolName : undefined}
                        pendingPlan={!!m.streaming && !!pendingPlan}
                        pendingQuestion={!!m.streaming && !!pendingQuestion}
                        showTodos={m.id === lastAssistantId}
                        genStartedAt={m.streaming ? genStartedAt : undefined}
                        statusDetail={m.streaming ? statusDetail : undefined}
                        copied={copiedId === m.id}
                        onCopy={copyMessage}
                        onRegenerate={regenerateReply}
                      />
                    )}
                  </Fragment>
                  )
                })}
                <ContextNotices conversationId={conversationId} turn={lastUserId} />
              </div>
            )}
          </div>
        </div>
        <div className="fade fade--top" aria-hidden="true" />
        <div className="fade fade--bottom" aria-hidden="true" />
        {!atBottom && messages.length > 0 && (
          <button className="scrolldown" onClick={scrollToBottom} aria-label="Scroll to latest"><ArrowDown size={16} /></button>
        )}
      </div>

      <div className="col dock">
        <RestoreNotice />
        {planLoadError && conversationId && (
          <div className="plan-load-error" role="alert">
            <span>{planLoadError}</span>
            <button onClick={() => void loadPlans(conversationId)}>Retry</button>
          </div>
        )}
        {pendingPlan && <PlanCard ask={pendingPlan} pending onOpen={() => openPlan(pendingPlan)} />}
        {pendingQuestion && <QuestionCard key={pendingQuestion.id} ask={pendingQuestion} onResolve={(answers) => resolveQuestion(pendingQuestion.id, answers)} />}
        {pendingPermission && (
          <PermissionCard key={pendingPermission.id} ask={pendingPermission} workspace={workspace} onDecide={(decision) => resolvePermission(pendingPermission.id, decision)} />
        )}
        {contextShortened && <div className="context-history-note" role="status"><History size={12} aria-hidden="true" /><span>{contextSummary ? 'Using a summary of earlier messages. Full history is saved.' : 'Using recent messages. Full history is saved.'}</span></div>}
        <Composer modelOpen={modelOpen} setModelOpen={setModelOpen} />
      </div>
    </div>
  )
}
