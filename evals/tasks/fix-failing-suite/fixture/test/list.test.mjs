import { test } from 'node:test'
import assert from 'node:assert/strict'
import { joinWords, ranking } from '../src/list.mjs'

test('joinWords', () => {
  assert.equal(joinWords([]), '')
  assert.equal(joinWords(['a']), 'a')
  assert.equal(joinWords(['a', 'b', 'c']), 'a, b and c')
})

test('ranking numbers the names, teens included', () => {
  const names = Array.from({ length: 13 }, (_, i) => `p${i + 1}`)
  const lines = ranking(names).split('\n')
  assert.equal(lines[0], '1st p1')
  assert.equal(lines[10], '11th p11')
  assert.equal(lines[12], '13th p13')
})
