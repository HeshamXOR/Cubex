'use strict'
// A scripted stand-in for Claude Code in its stream-json mode, for testing the bridge (peers/claude/bridge.ts). It speaks the
// same protocol on its standard input and output: control requests and responses, user, assistant and result messages.
// What it does is chosen by lines in the message it is sent, one directive per line:
//   @claude say <text>              an assistant message with that text
//   @claude echo                    an assistant message with the whole text of the message it was sent
//   @claude think                   an assistant message with only a thinking block
//   @claude tool <Name> <json>      a tool call that asks first (can_use_tool); runs when allowed, fails when denied
//   @claude silent <Name> <json>    a tool call that runs without asking
//   @claude subagent <text>         a message from a subagent
//   @claude login                   the result Claude Code gives when it has no login
//   @claude fail <text>             a result that is an error
//   @claude maxturns                a result that stopped for want of turns
//   @claude hang                    works until it is interrupted
//   @claude exit <code>             ends the program
// The environment sets the rest: MOCK_RECORD (a file every message and the start-up facts are appended to), MOCK_ACCOUNT (the
// account the initialize response reports, as JSON), MOCK_NO_INIT (never answers initialize), MOCK_STDERR, MOCK_EXIT_AT_START,
// MOCK_UNKNOWN_REQUEST (asks Cubex for something it does not serve), MOCK_REAL_WRITE (a Write that is allowed writes the file),
// MOCK_DEFAULT_SAY (what it answers a message that has no directive in it).
const { createInterface } = require('node:readline')
const { appendFileSync, writeFileSync } = require('node:fs')

const record = process.env.MOCK_RECORD
const log = (entry) => { if (record) appendFileSync(record, `${JSON.stringify(entry)}\n`) }
const out = (message) => process.stdout.write(`${JSON.stringify(message)}\n`)

const VARIABLES = ['DISABLE_AUTOUPDATER', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDECODE', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'PLAIN', 'CLAUDE_CODE_SSE_PORT']
const seen = {}
for (const name of VARIABLES) seen[name] = process.env[name] === undefined ? null : process.env[name]
log({ started: { argv: process.argv.slice(2), cwd: process.cwd(), env: seen } })

if (process.env.MOCK_STDERR) process.stderr.write(process.env.MOCK_STDERR)
if (process.env.MOCK_EXIT_AT_START) process.exit(Number(process.env.MOCK_EXIT_AT_START))

let requests = 0
let tools = 0
let interrupted = false
let wake
const waiting = new Map()

const assistant = (content, extra = {}) => ({ type: 'assistant', message: { id: `msg_${++tools}`, type: 'message', role: 'assistant', model: 'claude-mock', content, stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }, parent_tool_use_id: null, session_id: 'mock', ...extra })
const toolResult = (id, text, isError) => ({ type: 'user', message: { role: 'user', content: [{ tool_use_id: id, type: 'tool_result', content: text, ...(isError ? { is_error: true } : {}) }] }, parent_tool_use_id: null, session_id: 'mock' })

async function ask(id, name, input) {
  const requestId = `mock-${++requests}`
  out({ type: 'control_request', request_id: requestId, request: { subtype: 'can_use_tool', tool_name: name, display_name: name, input, description: name, permission_suggestions: [], tool_use_id: id } })
  const answer = await new Promise((resolve) => waiting.set(requestId, resolve))
  return answer && answer.response ? answer.response : {}
}

async function turn(message) {
  const content = message.message && message.message.content
  const text = Array.isArray(content) ? content.map((block) => (block && block.type === 'text' ? block.text : '')).join('\n') : ''
  interrupted = false
  let last = ''
  for (const line of text.split('\n')) {
    const match = /^@claude (\w+)(?: (.*))?$/.exec(line.trim())
    if (!match) continue
    const [, command, rest = ''] = match
    if (interrupted) break
    if (command === 'say') { last = rest; out(assistant([{ type: 'text', text: rest }])) }
    else if (command === 'echo') { last = text; out(assistant([{ type: 'text', text }])) }
    else if (command === 'think') out(assistant([{ type: 'thinking', thinking: 'hmm', signature: 'x' }]))
    else if (command === 'subagent') out(assistant([{ type: 'text', text: rest }], { parent_tool_use_id: 'toolu_parent' }))
    else if (command === 'tool' || command === 'silent') {
      const space = rest.indexOf(' ')
      const name = space < 0 ? rest : rest.slice(0, space)
      const input = space < 0 ? {} : JSON.parse(rest.slice(space + 1))
      const id = `toolu_${++tools}`
      out(assistant([{ type: 'tool_use', id, name, input }]))
      if (command === 'silent') { out(toolResult(id, 'done without asking', false)); continue }
      const decision = await ask(id, name, input)
      if (decision.behavior === 'allow') {
        if (name === 'Write' && process.env.MOCK_REAL_WRITE) writeFileSync(input.file_path, input.content)
        out(toolResult(id, `${name} done`, false))
      } else {
        out(toolResult(id, decision.message || 'denied', true))
      }
    }
    else if (command === 'login') {
      out(assistant([{ type: 'text', text: 'Not logged in · Please run /login' }], {}))
      out({ type: 'result', subtype: 'success', is_error: true, result: 'Not logged in · Please run /login', stop_reason: 'stop_sequence', session_id: 'mock' })
      return
    }
    else if (command === 'fail') { out({ type: 'result', subtype: 'success', is_error: true, result: rest, session_id: 'mock' }); return }
    else if (command === 'maxturns') { out({ type: 'result', subtype: 'error_max_turns', is_error: false, session_id: 'mock' }); return }
    else if (command === 'hang') await new Promise((resolve) => { wake = resolve })
    else if (command === 'exit') process.exit(Number(rest || 0))
  }
  if (interrupted) {
    out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: '[Request interrupted by user]', session_id: 'mock' })
    return
  }
  // A message with no directive gets this answer, when the environment gives one: what a program that is simply asked a question does.
  if (!last && process.env.MOCK_DEFAULT_SAY) { last = process.env.MOCK_DEFAULT_SAY; out(assistant([{ type: 'text', text: last }])) }
  out({ type: 'result', subtype: 'success', is_error: false, result: last, stop_reason: 'end_turn', session_id: 'mock', total_cost_usd: 0, usage: {} })
}

createInterface({ input: process.stdin }).on('line', (line) => {
  let message
  try { message = JSON.parse(line) } catch { return }
  log({ received: message })
  if (message.type === 'control_request') {
    const request = message.request || {}
    if (request.subtype === 'initialize') {
      if (process.env.MOCK_NO_INIT) return
      const account = process.env.MOCK_ACCOUNT ? JSON.parse(process.env.MOCK_ACCOUNT) : { tokenSource: 'claude.ai', apiProvider: 'firstParty' }
      out({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: { commands: [], agents: [], output_style: 'default', models: [], account, pid: process.pid } } })
      if (process.env.MOCK_UNKNOWN_REQUEST) out({ type: 'control_request', request_id: 'mock-hook', request: { subtype: 'hook_callback', callback_id: 'x', input: {} } })
    } else if (request.subtype === 'interrupt') {
      interrupted = true
      out({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id } })
      if (wake) { wake(); wake = undefined }
    }
  } else if (message.type === 'control_response') {
    const resolve = waiting.get(message.response && message.response.request_id)
    if (resolve) { waiting.delete(message.response.request_id); resolve(message.response) }
  } else if (message.type === 'user') {
    void turn(message)
  }
}).on('close', () => process.exit(0))
