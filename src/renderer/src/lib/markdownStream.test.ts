import { describe, expect, it } from 'vitest'
import { advanceReveal, repairMarkdown, splitMarkdownBlocks, wordBoundary } from './markdownStream'

describe('repairMarkdown', () => {
  it('leaves finished markdown alone', () => {
    const text = '# Title\n\nSome **bold** and `code`, a [link](https://example.com).\n\n- one\n- two\n'
    expect(repairMarkdown(text)).toBe(text)
  })

  it('closes an open code fence', () => {
    expect(repairMarkdown('```ts\nconst a = 1')).toBe('```ts\nconst a = 1\n```')
    expect(repairMarkdown('~~~\nx')).toBe('~~~\nx\n~~~')
  })

  it('never treats markers inside code as markdown', () => {
    expect(repairMarkdown('```md\n**not bold\n| a |')).toBe('```md\n**not bold\n| a |\n```')
  })

  it('holds back markers that change meaning as they grow', () => {
    for (const tail of ['#', '##', '-', '*', '+', '1', '12.', '3)', '--', '==', '__', '**', '>', '`', '``']) {
      expect(repairMarkdown(`Intro\n${tail}`)).toBe('Intro')
    }
  })

  it('hides a table until its delimiter row arrives', () => {
    expect(repairMarkdown('Results:\n\n| Name | Size')).toBe('Results:\n')
    expect(repairMarkdown('Results:\n\n| Name | Size |\n')).toBe('Results:\n')
    expect(repairMarkdown('Results:\n\n| Name | Size |\n| --- | -')).toBe('Results:\n')
  })

  it('shows complete table rows and holds back the partial one', () => {
    const head = '| Name | Size |\n| --- | ---: |'
    expect(repairMarkdown(`${head}\n| a.ts | 2`)).toBe(head)
    expect(repairMarkdown(`${head}\n| a.ts | 2 |\n`)).toBe(`${head}\n| a.ts | 2 |\n`)
  })

  it('closes inline code', () => {
    expect(repairMarkdown('Run `npm i')).toBe('Run `npm i`')
  })

  it('closes emphasis that is still open', () => {
    expect(repairMarkdown('This is **bold')).toBe('This is **bold**')
    expect(repairMarkdown('This is **bold ')).toBe('This is **bold**')
    expect(repairMarkdown('An *aside')).toBe('An *aside*')
    expect(repairMarkdown('Was ~~wrong')).toBe('Was ~~wrong~~')
    expect(repairMarkdown('Call __init')).toBe('Call __init__')
  })

  it('shows a link label while its URL arrives', () => {
    expect(repairMarkdown('See [the docs](https://exa')).toBe('See the docs')
    expect(repairMarkdown('See [the do')).toBe('See the do')
    expect(repairMarkdown('See [the docs]')).toBe('See the docs')
    expect(repairMarkdown('See [a](x) and [b](y')).toBe('See [a](x) and b')
  })

  it('repairs only the paragraph being written', () => {
    expect(repairMarkdown('An **open marker\n\nNew *line')).toBe('An **open marker\n\nNew *line*')
    expect(repairMarkdown('- one **a\n- two')).toBe('- one **a\n- two')
    expect(repairMarkdown('# A **title\nBody **x')).toBe('# A **title\nBody **x**')
  })

})

describe('splitMarkdownBlocks', () => {
  const cases = [
    'a\n\nb',
    'a\n\n\nb\n',
    '# Title\nBody\n\n- a\n- b\n\n- c\n\nAfter',
    'Here:\n```js\nconst x = 1\n\nconst y = 2\n```\n\nDone',
    '- a\n\n  ```sh\n  npm i\n  ```\n- b\n\nEnd',
    '| a | b |\n| - | - |\n| 1 | 2 |\n\nText',
    'trailing\n\n'
  ]

  it('joins back to the exact input', () => {
    for (const text of cases) expect(splitMarkdownBlocks(text).join('')).toBe(text)
  })

  it('splits at blank lines', () => {
    expect(splitMarkdownBlocks('a\n\nb')).toEqual(['a\n\n', 'b'])
  })

  it('keeps blank lines inside a fence', () => {
    expect(splitMarkdownBlocks(cases[3]!)).toEqual(['Here:\n', '```js\nconst x = 1\n\nconst y = 2\n```\n\n', 'Done'])
  })

  it('keeps a growing block stable once it is finished', () => {
    const before = splitMarkdownBlocks('- a\n- b\n\n')
    const after = splitMarkdownBlocks('- a\n- b\n\nDone')
    expect(after[0]).toBe(before[0])
  })

})

describe('reveal helpers', () => {
  it('finds the end of the last whole word', () => {
    expect(wordBoundary('hello wor')).toBe(6)
    expect(wordBoundary('hello ')).toBe(6)
    expect(wordBoundary('hello')).toBe(0)
  })

  it('advances by whole words', () => {
    expect(advanceReveal('hello world', 0, 3)).toBe(5)
    expect(advanceReveal('hello world', 5, 1)).toBe(11)
    expect(advanceReveal('hello world', 0, 0)).toBe(5)
  })

})
