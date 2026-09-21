import { useState, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Check, Copy } from 'lucide-react'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism'

function CodeBlock({ language, value }: { language: string; value: string }): JSX.Element {
  const [copied, setCopied] = useState(false)
  const copy = (): void => {
    void navigator.clipboard.writeText(value).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1400)
    })
  }
  return (
    <div className="codeblock">
      <div className="codeblock__bar">
        <span>{language || 'text'}</span>
        <button className="codeblock__copy" onClick={copy}>
          {copied ? <Check size={12} /> : <Copy size={12} />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <SyntaxHighlighter
        language={language || 'text'}
        style={oneDark}
        customStyle={{
          margin: 0,
          background: 'var(--bg-app)',
          fontSize: 12.5,
          padding: '14px 16px',
          lineHeight: 1.6
        }}
        PreTag="div"
      >
        {value}
      </SyntaxHighlighter>
    </div>
  )
}

/** Markdown with GFM tables/lists and syntax-highlighted fenced code. */
export function Markdown({ text }: { text: string }): JSX.Element {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        code({ inline, className, children, ...props }: {
          inline?: boolean
          className?: string
          children?: ReactNode
        }) {
          const match = /language-(\w+)/.exec(className ?? '')
          const value = String(children ?? '').replace(/\n$/, '')
          if (!inline && match) return <CodeBlock language={match[1] ?? 'text'} value={value} />
          if (!inline && value.includes('\n')) return <CodeBlock language="text" value={value} />
          return (
            <code className={className} {...props}>
              {children}
            </code>
          )
        }
      }}
    >
      {text}
    </ReactMarkdown>
  )
}
