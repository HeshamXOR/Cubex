import assert from 'node:assert/strict'
import { test } from 'node:test'
import { lateFee } from '../src/fees.mjs'

test('no fee on the due date', () => assert.equal(lateFee(0, 100), 0))
test('a fee once overdue', () => assert.equal(lateFee(1, 100), 5))
test('no fee before the due date', () => assert.equal(lateFee(-3, 100), 0))
