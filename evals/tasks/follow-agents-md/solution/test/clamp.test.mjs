import { test } from 'node:test'
import assert from 'node:assert/strict'
import { clamp } from '../src/clamp.mjs'

test('clamp limits a value to the range', () => {
  assert.equal(clamp(5, 0, 10), 5)
  assert.equal(clamp(-5, 0, 10), 0)
  assert.equal(clamp(15, 0, 10), 10)
})

test('clamp throws when min is greater than max', () => {
  assert.throws(() => clamp(1, 10, 0), RangeError)
})
