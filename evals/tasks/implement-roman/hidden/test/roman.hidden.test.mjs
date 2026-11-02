import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fromRoman, toRoman } from '../src/roman.mjs'

test('every number from 1 to 3999 survives the round trip', () => {
  for (let n = 1; n <= 3999; n++) assert.equal(fromRoman(toRoman(n)), n, `n = ${n}`)
})

test('known numerals', () => {
  assert.equal(toRoman(3888), 'MMMDCCCLXXXVIII')
  assert.equal(toRoman(49), 'XLIX')
  assert.equal(toRoman(3999), 'MMMCMXCIX')
  assert.equal(fromRoman('xl'), 40)
})

test('toRoman rejects non-integers and out of range numbers', () => {
  for (const bad of [0, -3, 4000, 2.5, NaN, Infinity]) assert.throws(() => toRoman(bad), RangeError, String(bad))
})

test('fromRoman rejects strings that are not in the standard form', () => {
  for (const bad of ['', 'IIII', 'VX', 'IC', 'XXXX', 'IVI', 'MMMM', 'ABC', 'IIX', 'VV', 'LC', ' X', 'X ']) {
    assert.throws(() => fromRoman(bad), SyntaxError, JSON.stringify(bad))
  }
})
