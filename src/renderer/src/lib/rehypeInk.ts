/**
 * A rehype plugin that wraps every word of prose in `<span class="ink">`, so
 * newly revealed words can fade in. Words inside code are left alone: code
 * keeps its own syntax markup and should appear without effects.
 *
 * Only elements are created here, never text styling, so the plugin is a
 * no-op for how the finished message looks and copies.
 */
interface HastNode {
  type: string
  value?: string
  tagName?: string
  properties?: Record<string, unknown>
  children?: HastNode[]
  position?: { start?: { offset?: number } }
}

export interface InkOptions {
  /** Source offset below which words are treated as already on screen and are not animated. */
  baseline?: number
}

const SKIP = new Set(['pre', 'code', 'script', 'style', 'textarea', 'svg'])

function splitWords(node: HastNode, baseline: number): HastNode[] {
  const value = node.value ?? ''
  if (!value.trim()) return [node]
  const origin = node.position?.start?.offset
  const out: HastNode[] = []
  let cursor = 0
  for (const token of value.split(/(\s+)/)) {
    if (!token) continue
    const isSpace = /^\s+$/.test(token)
    const animated = !isSpace && (origin === undefined || origin + cursor >= baseline)
    cursor += token.length
    out.push(animated
      ? { type: 'element', tagName: 'span', properties: { className: ['ink'] }, children: [{ type: 'text', value: token }] }
      : { type: 'text', value: token })
  }
  return out
}

function wrap(node: HastNode, baseline: number): void {
  if (!node.children) return
  const next: HastNode[] = []
  for (const child of node.children) {
    if (child.type === 'text') {
      next.push(...splitWords(child, baseline))
      continue
    }
    if (child.type !== 'element' || !SKIP.has(child.tagName ?? '')) wrap(child, baseline)
    next.push(child)
  }
  node.children = next
}

export function rehypeInk(options: InkOptions = {}): (tree: HastNode) => void {
  const baseline = options.baseline ?? 0
  return (tree) => wrap(tree, baseline)
}
