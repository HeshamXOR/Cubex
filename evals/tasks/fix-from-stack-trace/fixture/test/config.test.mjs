import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadConfig } from '../src/config.mjs'

test('reads port and hosts', () => {
  const config = loadConfig('port = 8080\nallowed_hosts = example.com, api.example.com\n')
  assert.equal(config.port, 8080)
  assert.deepEqual(config.allowedHosts, ['example.com', 'api.example.com'])
})

test('ignores comments and blank lines', () => {
  const config = loadConfig('# comment\n\nallowed_hosts = a.com\n')
  assert.deepEqual(config.allowedHosts, ['a.com'])
})
