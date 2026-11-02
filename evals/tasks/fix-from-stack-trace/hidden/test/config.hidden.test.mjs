import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadConfig } from '../src/config.mjs'

test('a missing allowed_hosts is an empty list and the rest of the defaults hold', () => {
  assert.deepEqual(loadConfig('port = 80\n'), { port: 80, allowedHosts: [], logLevel: 'info' })
  assert.deepEqual(loadConfig(''), { port: 3000, allowedHosts: [], logLevel: 'info' })
})

test('an empty allowed_hosts is an empty list too', () => {
  assert.deepEqual(loadConfig('allowed_hosts =\n').allowedHosts, [])
})

test('lists are still trimmed and cleaned', () => {
  assert.deepEqual(loadConfig('allowed_hosts = a.com ,, b.com , c.com\n').allowedHosts, ['a.com', 'b.com', 'c.com'])
})

test('a bad line is still an error', () => {
  assert.throws(() => loadConfig('nonsense\n'), /bad config line/)
})

test('log_level is read', () => {
  assert.equal(loadConfig('log_level = debug\n').logLevel, 'debug')
})
