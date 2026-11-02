'use strict'
// A scripted stand-in for Google's Antigravity ACP runtime (agy_acp_server), for testing how Cubex starts it, signs in to it and
// holds it to a policy. It speaks the Agent Client Protocol on its standard input and output the way the real one does where
// that matters here: it needs `authenticate` before a session, it reports the address of Google's sign-in page when it has no
// saved sign-in, it names its tool fields its own way, and it sends questions for the person as permission requests.
// What it does in a session is chosen by lines in the message it is sent, one directive per line:
//   @agy say <text>       an agent message
//   @agy tool <json>      a tool call that asks first. The json adds to the call: kind, title, rawInput, locations, content
//   @agy question         a question for the person, as a permission request named interaction_...
//   @agy expire           the sign-in has expired: the runtime reports the address of the sign-in page in the middle of a turn
//   @agy hang             works until it is cancelled
//   @agy exit <code>      ends the program
// The environment sets the rest: MOCK_RECORD (a file the start-up facts and every message are appended to), MOCK_VERSION,
// MOCK_SIGNIN (what happens when it is asked to sign in: approve, deny or hang), MOCK_SESSION_ERROR (a session fails after it
// signed in), MOCK_NO_REPORT (the sign-in address is not printed), MOCK_EXIT_AT_START, MOCK_DEFAULT_SAY (what it answers a
// message that has no directive in it), MOCK_AUTH_URL (the sign-in address it reports), MOCK_USE_BROWSER (it reports the address
// the way the real runtime does, by starting the program BROWSER names, and prints nothing itself), MOCK_CONTROL (a file of
// NAME=value lines read at start, which can change any of these between one run and the next without restarting what starts it).
const { createInterface } = require('node:readline')
const { spawn } = require('node:child_process')
const { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } = require('node:fs')
const { delimiter, join } = require('node:path')

if (process.env.MOCK_CONTROL) {
  try {
    for (const line of readFileSync(process.env.MOCK_CONTROL, 'utf8').split(/\r?\n/)) {
      const at = line.indexOf('=')
      if (at > 0) process.env[line.slice(0, at)] = line.slice(at + 1)
    }
  } catch { /* no control file yet: the environment stands */ }
}

const record = process.env.MOCK_RECORD
const log = (entry) => { if (record) appendFileSync(record, `${JSON.stringify(entry)}\n`) }
const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)

const VARIABLES = ['GEMINI_HOME', 'AGY_ACP_FORCE_FILE_STORAGE', 'BROWSER', 'PYTHONUNBUFFERED', 'ELECTRON_RUN_AS_NODE', 'ANTIGRAVITY_HARNESS_PATH', 'TEMP', 'TMP', 'TMPDIR', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_CLOUD_PROJECT', 'GOOGLE_APPLICATION_CREDENTIALS', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'PLAIN']
const seen = {}
for (const name of VARIABLES) seen[name] = process.env[name] === undefined ? null : process.env[name]
log({ started: { argv: process.argv.slice(2), cwd: process.cwd(), env: seen } })
if (process.env.MOCK_STDERR) process.stderr.write(process.env.MOCK_STDERR)
if (process.env.MOCK_EXIT_AT_START) process.exit(Number(process.env.MOCK_EXIT_AT_START))

const home = process.env.GEMINI_HOME || '.'
const tokenDirectory = join(home, 'antigravity-acp')
const tokenPath = join(tokenDirectory, 'acp_token.json')
const authorizationUrl = process.env.MOCK_AUTH_URL || 'https://accounts.google.com/o/oauth2/v2/auth?client_id=mock&redirect_uri=http%3A%2F%2F127.0.0.1%3A43211%2F&response_type=code&state=mockstate&scope=openid'

let authenticated = false
let sessionId = ''
let requests = 0
let cancelled = false
let wake
const waiting = new Map()

// Splits a command line the way a POSIX shell does, which is how Python's webbrowser reads the BROWSER variable.
function shellSplit(text) {
  const words = []
  let word = null
  let quote = null
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quote === "'") { if (c === "'") quote = null; else word += c; continue }
    if (quote === '"') {
      if (c === '"') quote = null
      else if (c === '\\' && i + 1 < text.length && '"\\$`'.includes(text[i + 1])) word += text[++i]
      else word += c
      continue
    }
    if (c === "'" || c === '"') { quote = c; if (word === null) word = ''; continue }
    if (c === '\\' && i + 1 < text.length) { word = (word === null ? '' : word) + text[++i]; continue }
    if (/\s/.test(c)) { if (word !== null) { words.push(word); word = null } continue }
    word = (word === null ? '' : word) + c
  }
  if (word !== null) words.push(word)
  return words
}

// What Python's webbrowser does with BROWSER: the value is split on the platform's path separator, the first choice that has %s in
// it is split like a shell would, and %s in its arguments is the address. The program's error output is the runtime's own.
function openWithBrowser(url) {
  const choice = (process.env.BROWSER || '').split(delimiter).find((entry) => entry.includes('%s'))
  const [file, ...args] = shellSplit(choice || '')
  if (!file) return
  const child = spawn(file, args.map((arg) => arg.replaceAll('%s', url)), { stdio: ['ignore', 'ignore', 'inherit'], windowsHide: true })
  child.on('error', () => undefined)
}

const reportAuthorization = () => {
  if (process.env.MOCK_NO_REPORT) return
  if (process.env.MOCK_USE_BROWSER) { openWithBrowser(authorizationUrl); return }
  process.stdout.write(`Open the following link to authenticate the ACP server: ${authorizationUrl}\n`)
  process.stderr.write(`__CUBEX_ANTIGRAVITY_AUTH_URL__${JSON.stringify(authorizationUrl)}\n`)
}

function ask(method, params) {
  const id = ++requests
  send({ id: `agent-${id}`, method, params })
  return new Promise((resolve) => waiting.set(`agent-${id}`, resolve))
}

async function prompt(id, params) {
  cancelled = false
  const text = (params.prompt || []).map((block) => (block && block.type === 'text' ? block.text : '')).join('\n')
  const say = (value) => send({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: value } } } })
  let directives = 0
  for (const line of text.split('\n')) {
    const match = /^@agy (\w+)(?: (.*))?$/.exec(line.trim())
    if (!match || cancelled) continue
    directives++
    const [, command, rest = ''] = match
    if (command === 'say') say(rest)
    else if (command === 'tool') {
      const extra = rest ? JSON.parse(rest) : {}
      const call = { toolCallId: `call_${++requests}`, title: 'Run command', status: 'pending', rawInput: { CommandLine: 'npm test', Cwd: process.cwd() }, ...extra }
      send({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'tool_call', ...call } } })
      const answer = await ask('session/request_permission', {
        sessionId,
        toolCall: { ...call, title: `${call.title}?` },
        options: [
          { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'allow-always', name: 'Allow for this thread', kind: 'allow_always', _meta: { 'agy.security.warning': { message: 'Prompt injection can run commands.' } } },
          { optionId: 'reject', name: 'Deny', kind: 'reject_once' }
        ]
      })
      const outcome = answer && answer.result && answer.result.outcome ? answer.result.outcome : {}
      const allowed = outcome.outcome === 'selected' && outcome.optionId === 'allow-once'
      send({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'tool_call_update', toolCallId: call.toolCallId, status: allowed ? 'completed' : 'failed' } } })
      say(allowed ? 'the tool ran' : `the tool was refused (${outcome.outcome || 'no outcome'})`)
    } else if (command === 'question') {
      const answer = await ask('session/request_permission', {
        sessionId,
        toolCall: { toolCallId: 'interaction_7', title: 'Which database should the project use?' },
        options: [{ optionId: 'a', name: 'Use Postgres', kind: 'allow_once' }, { optionId: 'b', name: 'Use SQLite', kind: 'allow_once' }]
      })
      const outcome = answer && answer.result && answer.result.outcome ? answer.result.outcome : {}
      say(`question answered: ${outcome.outcome}${outcome.optionId ? ` ${outcome.optionId}` : ''}`)
    } else if (command === 'expire') {
      reportAuthorization()
      await new Promise((resolve) => { wake = resolve })
    } else if (command === 'hang') {
      await new Promise((resolve) => { wake = resolve })
    } else if (command === 'exit') process.exit(Number(rest || 0))
  }
  // A message with no directive gets this answer, when the environment gives one: what a program that is simply asked a question does.
  if (!cancelled && directives === 0 && process.env.MOCK_DEFAULT_SAY) say(process.env.MOCK_DEFAULT_SAY)
  send({ id, result: { stopReason: cancelled ? 'cancelled' : 'end_turn' } })
}

function handle(message) {
  const { id, method, params } = message
  if (method === 'initialize') {
    send({ id, result: {
      protocolVersion: 1,
      agentInfo: { name: 'antigravity-acp', title: 'Antigravity', version: process.env.MOCK_VERSION || '1.3.0' },
      agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} }, auth: { logout: {} } },
      authMethods: [
        { id: 'oauth-personal', name: 'Sign in with Google' },
        { id: 'oauth-business', name: 'Gemini Enterprise' },
        { id: 'gemini-api-key', name: 'Gemini API key' },
        { id: 'agent-platform', name: 'Agent Platform' }
      ]
    } })
  } else if (method === 'authenticate') {
    if (existsSync(tokenPath)) { authenticated = true; send({ id, result: {} }); return }
    reportAuthorization()
    const mode = process.env.MOCK_SIGNIN || 'approve'
    if (mode === 'hang') return
    setTimeout(() => {
      if (mode === 'deny') { send({ id, error: { code: -32603, message: 'access_denied: the user denied access' } }); return }
      mkdirSync(tokenDirectory, { recursive: true })
      writeFileSync(tokenPath, '{"mock":true}\n')
      authenticated = true
      send({ id, result: {} })
    }, 150)
  } else if (method === 'session/new') {
    if (!authenticated) { send({ id, error: { code: -32000, message: 'Authentication required' } }); return }
    if (process.env.MOCK_SESSION_ERROR) { send({ id, error: { code: -32603, message: process.env.MOCK_SESSION_ERROR } }); return }
    sessionId = `session-${process.pid}`
    send({ id, result: { sessionId, modes: { currentModeId: 'default', availableModes: [{ id: 'default', name: 'Default' }, { id: 'auto_edit', name: 'Auto Edit' }, { id: 'yolo', name: 'YOLO' }] } } })
  } else if (method === 'session/set_mode') {
    send({ id, result: {} })
  } else if (method === 'session/prompt') {
    void prompt(id, params)
  } else if (method === 'logout') {
    try { unlinkSync(tokenPath) } catch { /* not there */ }
    authenticated = false
    send({ id, result: {} })
  } else if (id !== undefined) {
    send({ id, error: { code: -32601, message: `Method not found: ${method}` } })
  }
}

createInterface({ input: process.stdin }).on('line', (line) => {
  let message
  try { message = JSON.parse(line) } catch { return }
  log({ received: message })
  if (message.method === 'session/cancel') { cancelled = true; if (wake) { wake(); wake = undefined } return }
  if (message.method) { handle(message); return }
  const resolve = waiting.get(message.id)
  if (resolve) { waiting.delete(message.id); resolve(message) }
}).on('close', () => process.exit(0))
