import { describe, expect, it } from 'vitest'
import { rehypeInk } from './rehypeInk'

type Node = { type: string; value?: string; tagName?: string; properties?: Record<string, unknown>; children?: Node[]; position?: { start?: { offset?: number } } }

const text = (value: string, offset?: number): Node => ({ type: 'text', value, ...(offset === undefined ? {} : { position: { start: { offset } } }) })
const el = (tagName: string, ...children: Node[]): Node => ({ type: 'element', tagName, properties: {}, children })
const root = (...children: Node[]): Node => ({ type: 'root', children })

/** The visible text of a tree. */
function flatten(node: Node): string {
  return node.type === 'text' ? node.value ?? '' : (node.children ?? []).map(flatten).join('')
}
function inks(node: Node): string[] {
  const own = node.type === 'element' && node.tagName === 'span' && (node.properties?.className as string[] | undefined)?.includes('ink')
    ? [flatten(node)] : []
  return [...own, ...(node.children ?? []).flatMap(inks)]
}

describe('rehypeInk', () => {
  it('wraps each word and keeps whitespace as plain text', () => {
    const tree = root(el('p', text('Hello brave  new\nworld')))
    rehypeInk()(tree)
    expect(inks(tree)).toEqual(['Hello', 'brave', 'new', 'world'])
    expect(flatten(tree)).toBe('Hello brave  new\nworld')
  })

  it('leaves code and preformatted text alone', () => {
    const tree = root(el('p', text('Run '), el('code', text('npm test')), text(' now')), el('pre', el('code', text('const a = 1'))))
    rehypeInk()(tree)
    expect(inks(tree)).toEqual(['Run', 'now'])
    expect(flatten(tree)).toBe('Run npm test nowconst a = 1')
  })

  it('reaches into emphasis, links and list items', () => {
    const tree = root(el('ul', el('li', el('strong', text('bold word')), text(' tail'))))
    rehypeInk()(tree)
    expect(inks(tree)).toEqual(['bold', 'word', 'tail'])
  })

  it('does not animate words before the baseline offset', () => {
    // "Hello world" starts at source offset 10, so "Hello" is at 10 and "world" at 16.
    const tree = root(el('p', text('Hello world', 10)))
    rehypeInk({ baseline: 14 })(tree)
    expect(inks(tree)).toEqual(['world'])
    expect(flatten(tree)).toBe('Hello world')
  })

  it('animates everything when the source position is unknown', () => {
    const tree = root(el('p', text('no position here')))
    rehypeInk({ baseline: 1000 })(tree)
    expect(inks(tree)).toEqual(['no', 'position', 'here'])
  })

  it('ignores whitespace-only text', () => {
    const tree = root(el('ul', text('\n'), el('li', text('x')), text('\n')))
    rehypeInk()(tree)
    expect(inks(tree)).toEqual(['x'])
    expect(flatten(tree)).toBe('\nx\n')
  })
})
