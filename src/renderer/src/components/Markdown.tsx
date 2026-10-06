import { Children, createContext, isValidElement, memo, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Check, Copy } from 'lucide-react'
import { stripXmlToolMarkup } from '@core/tools/xmlToolCalls'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { safeMarkdownUrl } from '../lib/markdownUrl'
import { repairMarkdown, splitMarkdownBlocks } from '../lib/markdownStream'
import { rehypeInk } from '../lib/rehypeInk'
import { useSmoothText } from '../lib/useSmoothText'
import { PathLink } from './PathLink'
import './markdown.css'

/** True for the block of an answer that is still being written. */
const LiveContext = createContext(false)

/** A live block that mounts already this long was restored, not typed, so it should not animate. */
const RESTORED_BLOCK = 160
/** While a code block streams, it is re-highlighted at most this often. */
const HIGHLIGHT_INTERVAL_MS = 140

/** The highlighter wraps its tokens in a pre; the block already supplies one. */
function Bare({ children }: { children?: ReactNode }): JSX.Element {
  return <>{children}</>
}

/** A value that follows `value`, but changes at most once per `interval` ms while `active`. */
function useThrottled(value: string, active: boolean, interval: number): string {
  const [throttled, setThrottled] = useState(value)
  const last = useRef(0)
  useEffect(() => {
    if (!active) { setThrottled(value); return }
    const wait = Math.max(0, last.current + interval - performance.now())
    const timer = window.setTimeout(() => { last.current = performance.now(); setThrottled(value) }, wait)
    return () => window.clearTimeout(timer)
  }, [value, active, interval])
  return active ? throttled : value
}

function CodeBlock({ language, value }: { language: string; value: string }): JSX.Element {
  const live = useContext(LiveContext)
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
  useEffect(() => {
    if (copyState === 'idle') return
    const timer = window.setTimeout(() => setCopyState('idle'), 1400)
    return () => window.clearTimeout(timer)
  }, [copyState])
  const copy = (): void => {
    void navigator.clipboard.writeText(value)
      .then(() => setCopyState('copied'))
      .catch(() => setCopyState('failed'))
  }
  // While the code is being written only finished lines are highlighted, and
  // the line in progress is plain text, so colors never flicker mid-token.
  const snapshot = useThrottled(value, live, HIGHLIGHT_INTERVAL_MS)
  const settledLength = live ? snapshot.lastIndexOf('\n') + 1 : value.length
  const settled = value.slice(0, settledLength)
  const tail = value.slice(settledLength)
  const name = language || 'text'
  return (
    <div className="codeblock">
      <div className="codeblock__bar">
        <span>{name}</span>
        <button className="codeblock__copy" type="button" onClick={copy} title={copyState === 'failed' ? 'Could not copy. Select the code or try again.' : 'Copy code'}>
          {copyState === 'copied' ? <Check size={12} /> : <Copy size={12} />}
          {copyState === 'copied' ? 'Copied' : copyState === 'failed' ? 'Try again' : 'Copy'}
        </button>
      </div>
      <pre className="codeblock__pre">
        <code className={`language-${name}`}>
          {settled && (
            <SyntaxHighlighter language={name} style={{}} useInlineStyles={false} PreTag={Bare} CodeTag="span">
              {settled}
            </SyntaxHighlighter>
          )}
          {tail}
        </code>
      </pre>
    </div>
  )
}

const REMARK = [remarkGfm]

/**
 * Inline code. When it names a file or folder of the open project, it opens in the Files tab. A block that is
 * still being written is left alone, so half-typed names are not looked up one letter at a time.
 */
function InlineCode({ className, children }: { className?: string; children?: ReactNode }): JSX.Element {
  const live = useContext(LiveContext)
  const code = <code className={className}>{children}</code>
  return !live && typeof children === 'string' ? <PathLink text={children}>{code}</PathLink> : code
}

const COMPONENTS = {
  a({ href, children }: { href?: string; children?: ReactNode }) {
    // Without a target the click is a navigation that will-navigate
    // blocks; _blank routes through the external-open scheme allowlist.
    return href ? <a href={href} target="_blank" rel="noreferrer">{children}</a> : <span>{children}</span>
  },
  code: InlineCode,
  pre({ children }: { children?: ReactNode }) {
    // ReactMarkdown owns the block boundary. Handling it here avoids a
    // div inside its pre and also catches a one-line fence without a language.
    const code = Children.toArray(children)[0]
    if (!isValidElement<{ className?: string; children?: ReactNode }>(code) || code.type !== InlineCode) {
      return <pre>{children}</pre>
    }
    const language = /(?:^|\s)language-([^\s]+)/.exec(code.props.className ?? '')?.[1] ?? 'text'
    const value = String(code.props.children ?? '').replace(/\n$/, '')
    return <CodeBlock language={language} value={value} />
  }
}

interface BlockProps { source: string; live: boolean }

/** One top-level block. Finished blocks never re-render while a later block grows. */
const MarkdownBlock = memo(function MarkdownBlock({ source, live }: BlockProps): JSX.Element {
  const baseline = useRef(live && source.length > RESTORED_BLOCK ? source.length : 0)
  const rehype = useMemo(() => (live ? [[rehypeInk, { baseline: baseline.current }]] : []), [live])
  return (
    <LiveContext.Provider value={live}>
      <ReactMarkdown
        remarkPlugins={REMARK}
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        rehypePlugins={rehype as any}
        urlTransform={safeMarkdownUrl}
        components={COMPONENTS}
      >
        {source}
      </ReactMarkdown>
    </LiveContext.Provider>
  )
})

/** Link reference definitions can be used from any block, so such text is rendered whole. */
const HAS_REFERENCE_DEFINITIONS = /^ {0,3}\[[^\]\n]+\]:\s*\S/m

/**
 * Markdown with GFM tables/lists and syntax-highlighted fenced code.
 *
 * While `streaming`, the text is revealed as a steady flow of words and
 * repaired so every prefix renders like the finished answer: no raw pipes,
 * no half-open fences, no cursor. Only the block being written re-renders.
 */
export function Markdown({ text, streaming = false }: { text: string; streaming?: boolean }): JSX.Element {
  // Hide any tool-call XML the model streamed as text (fs_read/<invoke> etc.);
  // the harness executes those calls separately — the raw markup is never shown.
  const clean = useMemo(() => stripXmlToolMarkup(text), [text])
  const shown = useSmoothText(clean, streaming)
  const settled = shown === clean && !streaming
  const source = useMemo(() => (settled ? clean : repairMarkdown(shown)), [settled, clean, shown])
  const blocks = useMemo(
    () => (HAS_REFERENCE_DEFINITIONS.test(source) ? [source] : splitMarkdownBlocks(source)),
    [source]
  )
  return (
    <>
      {blocks.map((block, index) => (
        <MarkdownBlock key={index} source={block} live={!settled && index === blocks.length - 1} />
      ))}
    </>
  )
}
