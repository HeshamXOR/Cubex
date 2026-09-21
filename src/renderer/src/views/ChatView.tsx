import { useEffect, useRef, useState } from 'react'
import {
  Boxes,
  Check,
  ChevronDown,
  Code2,
  Copy,
  FileText,
  Globe,
  ImageIcon,
  Lightbulb,
  Paperclip,
  Plus,
  RefreshCw,
  ScanText,
  SendHorizontal,
  Square,
  Wrench,
  Zap
} from 'lucide-react'
import { useStore } from '../state/store'
import { effortOptionsFor } from '@core/providers'
import { Markdown } from '../components/Markdown'
import { ActivityRow } from '../status/ActivityRow'
import { matchCommands } from '../lib/slashCommands'
import { CubexMark, CubexWordmark } from '../theme/Logo'

const SUGGESTIONS = [
  { icon: ScanText, title: 'Analyze', sub: 'a file or dataset', prompt: 'Analyze this dataset and summarize the key patterns: ' },
  { icon: Lightbulb, title: 'Explain', sub: 'a concept', prompt: 'Explain this concept clearly, with an example: ' },
  { icon: Code2, title: 'Solve', sub: 'a problem', prompt: 'Help me solve this problem step by step: ' },
  { icon: FileText, title: 'Write', sub: 'a document', prompt: 'Write a document about: ' }
]

const BUSY = ['thinking', 'working', 'editing', 'streaming', 'retrying', 'falling_back', 'running_tool']

export function ChatView(): JSX.Element {
  const messages = useStore((s) => s.liveMessages)
  const status = useStore((s) => s.status)
  const genStartedAt = useStore((s) => s.genStartedAt)
  const statusDetail = useStore((s) => s.statusDetail)
  const activeProviderId = useStore((s) => s.activeProviderId)
  const providers = useStore((s) => s.providers)
  const send = useStore((s) => s.sendMessage)
  const cancel = useStore((s) => s.cancel)
  const regenerate = useStore((s) => s.regenerate)
  const webSearch = useStore((s) => s.webSearch)
  const toggleWebSearch = useStore((s) => s.toggleWebSearch)
  const subagents = useStore((s) => s.subagents)
  const toggleSubagents = useStore((s) => s.toggleSubagents)
  const effort = useStore((s) => s.effort)
  const setEffort = useStore((s) => s.setEffort)
  const setView = useStore((s) => s.setView)
  const runSlash = useStore((s) => s.runSlashCommand)
  const sessionSystem = useStore((s) => s.sessionSystem)

  const activeKind = providers.find((p) => p.id === activeProviderId)?.kind
  const effortOptions = activeKind ? effortOptionsFor(activeKind) : []

  const scrollRef = useRef<HTMLDivElement>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const [text, setText] = useState('')
  const [effortOpen, setEffortOpen] = useState(false)

  const busy = BUSY.includes(status)
  const ready = !!activeProviderId && providers.some((p) => p.id === activeProviderId && p.enabled)

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages])

  // Auto-grow the textarea.
  useEffect(() => {
    const ta = taRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = `${Math.min(ta.scrollHeight, 220)}px`
  }, [text])

  const commandMatches = matchCommands(text)
  const showPalette = text.startsWith('/') && commandMatches.length > 0

  const submit = (): void => {
    const t = text.trim()
    if (!t || busy) return
    // Slash commands run locally and never require a provider.
    if (t.startsWith('/')) {
      setText('')
      void runSlash(t).then((handled) => {
        if (!handled && ready) void send(t)
      })
      return
    }
    if (!ready) return
    setText('')
    void send(t)
  }

  const runFirstCommand = (): void => {
    const first = commandMatches[0]
    if (first) setText(`/${first.name} `)
    taRef.current?.focus()
  }

  const useSuggestion = (prompt: string): void => {
    setText(prompt)
    taRef.current?.focus()
  }

  const effortLabel = effortOptions.find((e) => e.value === effort)?.label ?? 'Default'

  return (
    <div className="chat">
      <div className="chat__scroll" ref={scrollRef}>
        {messages.length === 0 ? (
          <div className="hero">
            <div className="hero__mark">
              <CubexMark size={92} />
            </div>
            <div className="hero__word">
              <CubexWordmark size={30} tagline />
            </div>
            <h1 className="hero__title">How can I help you today?</h1>
            <div className="hero__cards">
              {SUGGESTIONS.map(({ icon: Icon, title, sub, prompt }) => (
                <button key={title} className="scard" onClick={() => useSuggestion(prompt)}>
                  <Icon size={21} strokeWidth={1.6} />
                  <span>
                    <span className="scard__title">{title}</span>
                    <br />
                    <span className="scard__sub">{sub}</span>
                  </span>
                </button>
              ))}
            </div>
            {!ready && (
              <div className="notice notice--warn" style={{ marginTop: 28, maxWidth: 560 }}>
                No provider configured yet.{' '}
                <button
                  onClick={() => setView('providers')}
                  style={{ color: 'inherit', textDecoration: 'underline', fontWeight: 600 }}
                >
                  Add one in Providers
                </button>{' '}
                — the built-in Mock provider needs no API key and works offline.
              </div>
            )}
          </div>
        ) : (
          <div className="chat__thread">
            {messages.map((m) => (
              <div className="msg" key={m.id}>
                <div className={`msg__avatar msg__avatar--${m.role === 'user' ? 'user' : 'ai'}`}>
                  {m.role === 'user' ? 'H' : <CubexMark size={15} />}
                </div>
                <div className="msg__body">
                  <div className="msg__who">{m.role === 'user' ? 'You' : 'Cubex'}</div>

                  {/* Harness activity block while this assistant turn is working
                      and hasn't produced visible text yet. */}
                  {m.role === 'assistant' && m.streaming && !m.text && !m.error && (
                    <ActivityRow state={status} startedAt={genStartedAt} detail={statusDetail} />
                  )}

                  {m.reasoning && (
                    <details className="reasoning" open>
                      <summary>Reasoning</summary>
                      <div style={{ marginTop: 8 }}>{m.reasoning}</div>
                    </details>
                  )}

                  {m.toolCalls?.map((tc) => (
                    <div className="toolcall" key={tc.id}>
                      <Wrench size={13} />
                      {tc.name}
                    </div>
                  ))}

                  {m.error ? (
                    <div className="msg__error">
                      <strong>{m.error.category}</strong> — {m.error.message}
                    </div>
                  ) : (
                    <div className="msg__content">
                      {m.role === 'assistant' ? (
                        <Markdown text={m.text} />
                      ) : (
                        <span style={{ whiteSpace: 'pre-wrap' }}>{m.text}</span>
                      )}
                      {m.streaming && <span className="caret" />}
                    </div>
                  )}

                  {m.role === 'assistant' && !m.streaming && m.text && (
                    <div className="msg__tools">
                      <button className="msg__tool" onClick={() => void navigator.clipboard.writeText(m.text)}>
                        <Copy size={12.5} /> Copy
                      </button>
                      <button className="msg__tool" onClick={() => void regenerate()}>
                        <RefreshCw size={12.5} /> Regenerate
                      </button>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="composer">
        {showPalette && (
          <div className="palette">
            <div className="palette__label">Commands</div>
            {commandMatches.map((c) => (
              <button
                key={c.name}
                className="palette__item"
                onClick={() => {
                  setText(`/${c.name} `)
                  taRef.current?.focus()
                }}
              >
                <span className="palette__cmd">
                  /{c.name}
                  {c.args ? <span className="palette__args"> {c.args}</span> : null}
                </span>
                <span className="palette__desc">{c.description}</span>
              </button>
            ))}
          </div>
        )}
        {sessionSystem && (
          <div className="composer__sysprompt" title={sessionSystem}>
            <Wrench size={12} />
            System prompt set for this chat · <span className="mono">{sessionSystem.slice(0, 60)}</span>
          </div>
        )}
        <div className="composer__box">
          <textarea
            ref={taRef}
            rows={1}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Tab' && showPalette) {
                e.preventDefault()
                runFirstCommand()
                return
              }
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                submit()
              }
            }}
            placeholder={ready ? 'Message Cubex...  (/ for commands)' : 'Configure a provider to start...'}
          />

          <div className="composer__row">
            <div className="composer__left">
              <button className="circbtn" title="Add context">
                <Plus size={17} />
              </button>
              <button className="circbtn" title="Attach file">
                <Paperclip size={16} />
              </button>
              <button className="circbtn" title="Attach image">
                <ImageIcon size={16} />
              </button>
            </div>

            <div className="composer__right">
              <button
                className={`pill ${webSearch ? 'pill--on' : ''}`}
                onClick={toggleWebSearch}
                title="Toggle web search (requires a provider tool)"
              >
                <Globe size={14} />
                Web search {webSearch ? 'on' : 'off'}
              </button>

              <button
                className={`pill ${subagents ? 'pill--on' : ''}`}
                onClick={toggleSubagents}
                title="Let the model delegate subtasks to isolated subagents"
              >
                <Boxes size={14} />
                Subagents {subagents ? 'on' : 'off'}
              </button>

              {effortOptions.length > 0 && (
                <div style={{ position: 'relative' }}>
                  <button
                    className={`pill ${effortOpen ? 'pill--open' : ''}`}
                    onClick={() => setEffortOpen((v) => !v)}
                    title="Reasoning effort for this provider"
                  >
                    <Zap size={14} />
                    Effort: {effortLabel}
                    <ChevronDown size={14} />
                  </button>
                  {effortOpen && (
                    <>
                      <div className="backdrop" onClick={() => setEffortOpen(false)} />
                      <div className="menu" style={{ bottom: 'calc(100% + 8px)', right: 0 }}>
                        <div className="menu__label">{activeKind === 'anthropic' ? 'Anthropic effort' : 'OpenAI reasoning effort'}</div>
                        {effortOptions.map((e) => (
                          <button
                            key={e.value}
                            className={`menu__item ${effort === e.value ? 'menu__item--sel' : ''}`}
                            onClick={() => {
                              setEffort(e.value)
                              setEffortOpen(false)
                            }}
                          >
                            <span>
                              <span className="menu__t">{e.label}</span>
                              <br />
                              <span className="menu__s">{e.hint}</span>
                            </span>
                            {effort === e.value && <Check size={15} className="menu__check" />}
                          </button>
                        ))}
                      </div>
                    </>
                  )}
                </div>
              )}

              {busy ? (
                <button className="sendbtn sendbtn--stop" onClick={cancel} title="Stop generating">
                  <Square size={14} fill="currentColor" />
                </button>
              ) : (
                <button className="sendbtn" onClick={submit} disabled={!text.trim() || !ready} title="Send">
                  <SendHorizontal size={17} />
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
