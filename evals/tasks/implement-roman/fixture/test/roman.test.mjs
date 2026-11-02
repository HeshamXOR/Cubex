import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fromRoman, toRoman } from '../src/roman.mjs'

test('toRoman handles the basic forms', () => {
  assert.equal(toRoman(1), 'I')
  assert.equal(toRoman(4), 'IV')
  assert.equal(toRoman(1994), 'MCMXCIV')
})

test('fromRoman reads them back', () => {
  assert.equal(fromRoman('XIV'), 14)
  assert.equal(fromRoman('mcmxciv'), 1994)
})

test('toRoman rejects what is out of range', () => {
  assert.throws(() => toRoman(0), RangeError)
  assert.throws(() => toRoman(4000), RangeError)
})
