'use strict'
// A scripted Agent Client Protocol agent, for tests. Not part of the app.
//
// How it behaves is set by environment variables when it starts, and by lines of the prompt that start with "@mock ".
// Every message it receives is appended to the file named by MOCK_RECORD, one JSON object per line, so a test can look at
// what the client sent.
//
//   MOCK_PROTOCOL=<n>          the protocol version it answers initialize with (default 1)
//   MOCK_AUTH=required         session/new fails with "authentication required" until authenticate has been called
//   MOCK_AUTH_METHODS=<json>   the authMethods it lists (default: one method, "login")
//   MOCK_AUTH_FAIL=1           authenticate fails
//   MOCK_MODES=<json>          {"current":"id","available":[{"id":"x","name":"X"}]}: the modes it offers
//   MOCK_MODES_VIA=config      offer the modes as a select option of category "mode" instead
//   MOCK_SET_MODE_FAIL=1       changing the mode fails
//   MOCK_NOISE=1               print lines that are not messages before anything else
//   MOCK_EXIT_AT_START=<code>  exit as soon as it starts
//   MOCK_EXIT_AT_PROMPT=<code> exit when a prompt arrives
//   MOCK_STDERR=<text>         write this to standard error at the start
//   MOCK_HANG_START=1          never answer initialize
//   MOCK_NO_SESSION_ID=1       answer session/new without a session id
//   MOCK_CANCEL_LATE=1         ignore session/cancel (a prompt that hangs then never ends)
//
// In a prompt:
//   @mock say <text>            reply with the text (\n becomes a line break). Without a directive: "OK.\nVerdict: agree"
//   @mock chunks a|b|c          reply in several chunks
//   @mock tool-between a|b      reply a, then a tool call, then b
//   @mock permission <kind> [path]   ask permission for a tool of that kind, then reply with what the client answered
//   @mock fs                    ask the client to read a file, then reply with the error code it got
//   @mock mode <id>             tell the client the mode changed, then reply
//   @mock hang                  never finish; finish as cancelled when session/cancel arrives
//   @mock refuse | max_tokens | max_turn_requests | empty | error   end the turn that way
//   @mock echo | pid | cwd | env <NAME>   reply with the prompt, the process id, the folder, or an environment variable
//   @mock edit <path>|<text>    ask permission to edit a file (kind edit, with the place and a diff), and write the text to
//                               it only when the client said yes. Replies "edit:allowed" or "edit:refused"
//   @mock edits <p>|<t> <> <p>|<t>   ask permission for two edits AT THE SAME TIME, as an agent that runs tools in parallel does
//   @mock delete <path>         ask permission to delete a file, and delete it only when allowed
//   @mock run <command>         ask permission to run a command (kind execute, with the command as its input), and
//                               replies "run:allowed" or "run:refused". Nothing is run
//   @mock sneak <path>|<text>   write the file WITHOUT asking: an agent that does not keep to the policy
//   @mock step <title>          report a tool call that starts and then completes (kind other)
//   @mock slow <ms>             wait that long, so a test can cancel or time out
//   @mock modes                 reply with the mode the session is in

const fs = require('node:fs')
const readline = require('node:readline')

const env = process.env
const record = (message) => { if (env.MOCK_RECORD) fs.appendFileSync(env.MOCK_RECORD, JSON.stringify(message) + '\n') }
const send = (message) => process.stdout.write(JSON.stringify(message) + '\n')
const reply = (id, result) => send({ jsonrpc: '2.0', id, result })
const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } })
const notify = (method, params) => send({ jsonrpc: '2.0', method, params })

if (env.MOCK_STDERR) process.stderr.write(env.MOCK_STDERR)
if (env.MOCK_EXIT_AT_START !== undefined) process.exit(Number(env.MOCK_EXIT_AT_START))
if (env.MOCK_NOISE === '1') {
  process.stdout.write('Debugger listening on ws://127.0.0.1:9229\n')
  process.stdout.write('[1,2,3]\n')
  process.stdout.write('\n')
}

const SESSION = 'mock-session-1'
let authenticated = env.MOCK_AUTH !== 'required'
let modes = env.MOCK_MODES ? JSON.parse(env.MOCK_MODES) : undefined
let nextRequest = 1000
const waiting = new Map()
let activePrompt

const toAgent = (method, params) => new Promise((resolve) => {
  const id = nextRequest++
  waiting.set(id, resolve)
  send({ jsonrpc: '2.0', id, method, params })
})

const text = (value) => notify('session/update', { sessionId: SESSION, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: value } } })
const lines = (value) => value.replace(/\\n/g, '\n')

function modeFields() {
  if (!modes) return {}
  if (env.MOCK_MODES_VIA === 'config') {
    return { configOptions: [{ id: 'mode', name: 'Mode', category: 'mode', type: 'select', currentValue: modes.current, options: modes.available.map((m) => ({ value: m.id, name: m.name })) }] }
  }
  return { modes: { currentModeId: modes.current, availableModes: modes.available } }
}

function finish(id, stopReason) { activePrompt = undefined; reply(id, { stopReason }) }

/** Ask permission to edit a file and write it only when the client said yes. A path may hold spaces, so the text is set apart by a bar. */
async function askEdit(arg) {
  const bar = arg.indexOf('|')
  const path = bar < 0 ? arg : arg.slice(0, bar)
  const content = bar < 0 ? '' : lines(arg.slice(bar + 1))
  let before = ''
  try { before = fs.readFileSync(path, 'utf8') } catch { /* a new file */ }
  const outcome = await toAgent('session/request_permission', {
    sessionId: SESSION,
    toolCall: {
      toolCallId: 'e' + nextRequest, title: 'Edit ' + path, kind: 'edit', locations: [{ path }],
      content: [{ type: 'diff', path, oldText: before, newText: content }]
    },
    options: [
      { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
      { optionId: 'once', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'no', name: 'Reject', kind: 'reject_once' }
    ]
  })
  const allowed = outcome && outcome.outcome && outcome.outcome.outcome === 'selected' && outcome.outcome.optionId === 'once'
  if (allowed) {
    fs.mkdirSync(require('node:path').dirname(path), { recursive: true })
    fs.writeFileSync(path, content)
  }
  return allowed ? 'edit:allowed ' + path : 'edit:refused ' + path
}

async function prompt(id, params) {
  const body = (params.prompt || []).map((block) => block.text || '').join('\n')
  const directives = body.split('\n').filter((line) => line.startsWith('@mock ')).map((line) => line.slice(6).trim())
  if (env.MOCK_EXIT_AT_PROMPT !== undefined) process.exit(Number(env.MOCK_EXIT_AT_PROMPT))
  activePrompt = id
  if (directives.length === 0) { text('OK.\nVerdict: agree'); return finish(id, 'end_turn') }
  for (const directive of directives) {
    const [word, ...rest] = directive.split(' ')
    const arg = rest.join(' ')
    switch (word) {
      case 'say': text(lines(arg)); break
      case 'chunks': for (const part of arg.split('|')) text(lines(part)); break
      case 'tool-between': {
        const [first, second] = arg.split('|')
        text(lines(first))
        notify('session/update', { sessionId: SESSION, update: { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Read a file', kind: 'read', status: 'completed' } })
        text(lines(second))
        break
      }
      case 'permission': {
        const [kind, path] = arg.split(' ')
        const outcome = await toAgent('session/request_permission', {
          sessionId: SESSION,
          toolCall: { toolCallId: 'p1', title: 'A tool', kind, ...(path ? { locations: [{ path }] } : {}) },
          options: [
            { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
            { optionId: 'once', name: 'Allow once', kind: 'allow_once' },
            { optionId: 'no', name: 'Reject', kind: 'reject_once' },
            { optionId: 'never', name: 'Always reject', kind: 'reject_always' }
          ]
        })
        text('permission:' + JSON.stringify(outcome))
        break
      }
      case 'fs': {
        const answer = await toAgent('fs/read_text_file', { sessionId: SESSION, path: 'x.txt' })
        text('fs:' + (answer && answer.error ? answer.error.code : 'ok'))
        break
      }
      case 'mode': notify('session/update', { sessionId: SESSION, update: { sessionUpdate: 'current_mode_update', currentModeId: arg } }); await new Promise((r) => setTimeout(r, 200)); text('mode changed'); break
      case 'hang': return
      case 'refuse': return finish(id, 'refusal')
      case 'max_tokens': text('Cut off'); return finish(id, 'max_tokens')
      case 'max_turn_requests': return finish(id, 'max_turn_requests')
      case 'empty': return finish(id, 'end_turn')
      case 'error': activePrompt = undefined; return fail(id, -32603, 'The model is overloaded. Try again later.')
      case 'echo': text(body); break
      case 'edit': text(await askEdit(arg)); break
      case 'edits': text((await Promise.all(arg.split(' <> ').map(askEdit))).join('\n')); break
      case 'delete': {
        const outcome = await toAgent('session/request_permission', {
          sessionId: SESSION,
          toolCall: { toolCallId: 'd' + nextRequest, title: 'Delete ' + arg, kind: 'delete', locations: [{ path: arg }] },
          options: [{ optionId: 'once', name: 'Allow once', kind: 'allow_once' }, { optionId: 'no', name: 'Reject', kind: 'reject_once' }]
        })
        const allowed = outcome && outcome.outcome && outcome.outcome.outcome === 'selected' && outcome.outcome.optionId === 'once'
        if (allowed) fs.rmSync(arg, { force: true })
        text(allowed ? 'delete:allowed ' + arg : 'delete:refused ' + arg)
        break
      }
      case 'run': {
        const outcome = await toAgent('session/request_permission', {
          sessionId: SESSION,
          toolCall: { toolCallId: 'r' + nextRequest, title: 'Run ' + arg, kind: 'execute', rawInput: { command: arg } },
          options: [{ optionId: 'once', name: 'Allow once', kind: 'allow_once' }, { optionId: 'no', name: 'Reject', kind: 'reject_once' }]
        })
        const allowed = outcome && outcome.outcome && outcome.outcome.outcome === 'selected' && outcome.outcome.optionId === 'once'
        text(allowed ? 'run:allowed ' + arg : 'run:refused ' + arg)
        break
      }
      case 'sneak': {
        const bar = arg.indexOf('|')
        const path = bar < 0 ? arg : arg.slice(0, bar)
        fs.mkdirSync(require('node:path').dirname(path), { recursive: true })
        fs.writeFileSync(path, bar < 0 ? '' : lines(arg.slice(bar + 1)))
        text('sneaked ' + path)
        break
      }
      case 'step': {
        const id = 's' + nextRequest++
        notify('session/update', { sessionId: SESSION, update: { sessionUpdate: 'tool_call', toolCallId: id, title: arg, kind: 'other', status: 'in_progress' } })
        await new Promise((r) => setTimeout(r, 20))
        notify('session/update', { sessionId: SESSION, update: { sessionUpdate: 'tool_call_update', toolCallId: id, status: 'completed' } })
        break
      }
      case 'slow': await new Promise((r) => setTimeout(r, Number(arg) || 0)); break
      case 'modes': text('mode:' + (modes ? modes.current : 'none')); break
      case 'pid': text(String(process.pid)); break
      case 'cwd': text(process.cwd()); break
      case 'env': text(arg + '=' + (process.env[arg] === undefined ? 'unset' : process.env[arg])); break
    }
  }
  finish(id, 'end_turn')
}

function handle(message) {
  record(message)
  if (message.method === undefined) {
    const resolve = waiting.get(message.id)
    if (resolve) { waiting.delete(message.id); resolve(message.error ? { error: message.error } : message.result) }
    return
  }
  const { id, method, params } = message
  switch (method) {
    case 'initialize':
      if (env.MOCK_HANG_START === '1') return
      return reply(id, {
        protocolVersion: env.MOCK_PROTOCOL ? Number(env.MOCK_PROTOCOL) : 1,
        agentCapabilities: { loadSession: false, promptCapabilities: {} },
        agentInfo: { name: 'mock-agent', version: '0.0.0' },
        authMethods: env.MOCK_AUTH_METHODS ? JSON.parse(env.MOCK_AUTH_METHODS) : [{ id: 'login', name: 'Log in' }]
      })
    case 'authenticate':
      if (env.MOCK_AUTH_FAIL === '1') return fail(id, -32603, 'Login was refused.')
      authenticated = true
      return reply(id, {})
    case 'session/new':
      if (!authenticated) return fail(id, -32000, 'Authentication required')
      if (env.MOCK_NO_SESSION_ID === '1') return reply(id, {})
      return reply(id, { sessionId: SESSION, ...modeFields() })
    case 'session/set_mode':
      if (env.MOCK_SET_MODE_FAIL === '1') return fail(id, -32603, 'Cannot change the mode.')
      if (modes) modes.current = params.modeId
      return reply(id, {})
    case 'session/set_config_option':
      if (env.MOCK_SET_MODE_FAIL === '1') return fail(id, -32603, 'Cannot change the mode.')
      if (modes) modes.current = params.value
      return reply(id, { configOptions: [] })
    case 'session/prompt':
      return void prompt(id, params)
    case 'session/cancel':
      if (env.MOCK_CANCEL_LATE === '1') return
      if (activePrompt !== undefined) finish(activePrompt, 'cancelled')
      return
    default:
      if (id !== undefined) fail(id, -32601, 'Method not found: ' + method)
  }
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return
  try { handle(JSON.parse(line)) } catch (error) { process.stderr.write('mock agent could not read: ' + line + '\n') }
}).on('close', () => process.exit(0))
