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

  it('keeps a shorter inner fence as code', () => {
    expect(repairMarkdown('````md\n```\ninner')).toBe('````md\n```\ninner\n````')
  })

  it('holds back a closing fence that is still being typed', () => {
    expect(repairMarkdown('```ts\nconst a = 1\n``')).toBe('```ts\nconst a = 1\n```')
  })

  it('waits for the info string of a new fence', () => {
    expect(repairMarkdown('Intro\n\n```typ')).toBe('Intro\n')
    expect(repairMarkdown('```ts\n')).toBe('```ts\n```')
  })

  it('never treats markers inside code as markdown', () => {
    expect(repairMarkdown('```md\n**not bold\n| a |')).toBe('```md\n**not bold\n| a |\n```')
  })

  it('holds back markers that change meaning as they grow', () => {
    for (const tail of ['#', '##', '-', '*', '+', '1', '12.', '3)', '--', '==', '__', '**', '>', '`', '``']) {
      expect(repairMarkdown(`Intro\n${tail}`)).toBe('Intro')
    }
  })

  it('shows a list item once it has text', () => {
    expect(repairMarkdown('Steps:\n- Add')).toBe('Steps:\n- Add')
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

  it('drops a backtick that has nothing after it yet', () => {
    expect(repairMarkdown('Run `')).toBe('Run')
  })

  it('closes emphasis that is still open', () => {
    expect(repairMarkdown('This is **bold')).toBe('This is **bold**')
    expect(repairMarkdown('This is **bold ')).toBe('This is **bold**')
    expect(repairMarkdown('An *aside')).toBe('An *aside*')
    expect(repairMarkdown('Was ~~wrong')).toBe('Was ~~wrong~~')
    expect(repairMarkdown('Call __init')).toBe('Call __init__')
  })

  it('closes nested emphasis innermost first', () => {
    expect(repairMarkdown('**bold *both')).toBe('**bold *both***')
    expect(repairMarkdown('***both')).toBe('***both***')
  })

  it('drops an opener that has no text yet', () => {
    expect(repairMarkdown('Some **')).toBe('Some')
    expect(repairMarkdown('Some ***')).toBe('Some')
    expect(repairMarkdown('**bold *')).toBe('**bold**')
    expect(repairMarkdown('Done ~~')).toBe('Done')
  })

  it('leaves stars that are not emphasis alone', () => {
    expect(repairMarkdown('2 * 3 = 6')).toBe('2 * 3 = 6')
    expect(repairMarkdown('* item one')).toBe('* item one')
    expect(repairMarkdown('Match *.ts files')).toBe('Match *.ts files')
    expect(repairMarkdown('snake__case stays')).toBe('snake__case stays')
  })

  it('ignores markers inside complete code spans', () => {
    expect(repairMarkdown('Use `a**b` here')).toBe('Use `a**b` here')
    expect(repairMarkdown('Use **`fetch`')).toBe('Use **`fetch`**')
  })

  it('shows a link label while its URL arrives', () => {
    expect(repairMarkdown('See [the docs](https://exa')).toBe('See the docs')
    expect(repairMarkdown('See [the do')).toBe('See the do')
    expect(repairMarkdown('See [the docs]')).toBe('See the docs')
    expect(repairMarkdown('See [a](x) and [b](y')).toBe('See [a](x) and b')
  })

  it('keeps brackets that are not links', () => {
    expect(repairMarkdown('Read items[0')).toBe('Read items[0')
    expect(repairMarkdown('- [ ] write tests')).toBe('- [ ] write tests')
  })

  it('hides an image until it is complete', () => {
    expect(repairMarkdown('Look ![diagram](https://x')).toBe('Look')
    expect(repairMarkdown('Look ![diagram](a.png) here')).toBe('Look ![diagram](a.png) here')
  })

  it('drops a trailing escape', () => {
    expect(repairMarkdown('Escaped \\')).toBe('Escaped')
  })

  it('repairs only the paragraph being written', () => {
    expect(repairMarkdown('An **open marker\n\nNew *line')).toBe('An **open marker\n\nNew *line*')
    expect(repairMarkdown('- one **a\n- two')).toBe('- one **a\n- two')
    expect(repairMarkdown('# A **title\nBody **x')).toBe('# A **title\nBody **x**')
  })

  it('leaves a finished paragraph alone', () => {
    expect(repairMarkdown('An **open marker\n\n')).toBe('An **open marker\n\n')
  })

  it('carries emphasis across lines of one paragraph', () => {
    expect(repairMarkdown('A **long\nline')).toBe('A **long\nline**')
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

  it('keeps a loose list whole', () => {
    expect(splitMarkdownBlocks(cases[2]!)).toEqual(['# Title\nBody\n\n', '- a\n- b\n\n- c\n\n', 'After'])
  })

  it('keeps a fenced block inside its list item', () => {
    expect(splitMarkdownBlocks(cases[4]!)).toEqual(['- a\n\n  ```sh\n  npm i\n  ```\n- b\n\n', 'End'])
  })

  it('keeps a growing block stable once it is finished', () => {
    const before = splitMarkdownBlocks('- a\n- b\n\n')
    const after = splitMarkdownBlocks('- a\n- b\n\nDone')
    expect(after[0]).toBe(before[0])
  })

  it('returns nothing for empty input', () => {
    expect(splitMarkdownBlocks('')).toEqual([])
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

  it('never passes the limit', () => {
    expect(advanceReveal('hello world', 0, 100, 6)).toBe(6)
    expect(advanceReveal('hello world', 8, 100, 6)).toBe(6)
  })
})
