import test from 'node:test'
import assert from 'node:assert/strict'
import { report } from '../src/report.mjs'

const rows = [
  { user_id: 1, amount: '5', profile_json: '{"name":"Ada"}' },
  { user_id: 1, amount: '7', profile_json: '{"name":"Ada"}' },
  { user_id: 2, amount: '3', profile_json: '{"data":{"name":"Linus"}}' }
]

test('a report lists each user with their total', () => {
  assert.equal(report(rows), 'Ada: 12\nLinus: 3')
})
