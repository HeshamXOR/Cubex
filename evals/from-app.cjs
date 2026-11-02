'use strict'
/**
 * Runs the eval suite against a provider saved in Cubex.
 *
 *   npx electron evals/from-app.cjs --provider "<name or id>" --model <id> [--user-data <dir>]
 *   npm run eval:app -- --provider "<name or id>" --model <id>
 *
 * This is an Electron main script because the app keeps API keys encrypted with Electron's safeStorage (DPAPI on
 * Windows, the Keychain on macOS, libsecret on Linux), which only an Electron process using the app's own user-data
 * folder can decrypt. It reads the provider the way the app does (src/main/db.ts, credentials.ts and
 * ProviderManager.resolveSecret), starts the eval run with CUBEX_EVAL_* set, and hands the key over in the child's
 * environment only. The key is never printed, and the child's output is scrubbed of it as a precaution.
 *
 * Options:
 *   --provider <name|id>   the provider as shown in Cubex (name, id, or a part of the name that matches one)
 *   --model <id>           the model to test (default: the provider's default model)
 *   --user-data <dir>      Cubex's user-data folder (default: the app's own, <appData>/cubex)
 *   --tasks a,b            only these tasks         (CUBEX_EVAL_TASKS)
 *   --repeat N             runs per task            (CUBEX_EVAL_REPEAT)
 *   --concurrency N        runs at the same time    (CUBEX_EVAL_CONCURRENCY)
 *   --effort <level>       reasoning effort         (CUBEX_EVAL_EFFORT)
 *   --kind <kind>          talk to the provider as another kind, e.g. openai for a gateway that only takes the Responses API
 *   --keep                 keep the workspaces      (CUBEX_EVAL_KEEP=1)
 *   --list                 list the saved providers and exit
 *   --dry-run              resolve the provider and show what would run (the key is only reported as present), then exit
 *   --models               list the provider's model ids (from its /models endpoint) and exit
 */
const { app, safeStorage } = require('electron')
const { spawn } = require('node:child_process')
const { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { dirname, join, resolve } = require('node:path')

const REPO = resolve(__dirname, '..')
const VALUE_FLAGS = ['--provider', '--model', '--user-data', '--tasks', '--repeat', '--concurrency', '--effort', '--kind']
const BOOLEAN_FLAGS = ['--keep', '--list', '--dry-run', '--models']

/** The same fallbacks as ProviderManager.resolveSecret, for a provider whose key is not in the store. */
const ENV_KEY_BY_KIND = {
  openai: 'CUBEX_OPENAI_API_KEY',
  anthropic: 'CUBEX_ANTHROPIC_API_KEY',
  gemini: 'CUBEX_GEMINI_API_KEY',
  'openai-compat': 'CUBEX_OPENAI_COMPAT_API_KEY'
}

function fail(message) {
  console.error(`eval:app: ${message}`)
  app.exit(2)
}

function parseArgs(argv) {
  const options = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const eq = arg.indexOf('=')
    const flag = arg.startsWith('--') && eq !== -1 ? arg.slice(0, eq) : arg
    if (BOOLEAN_FLAGS.includes(flag)) options[flag.slice(2)] = true
    else if (VALUE_FLAGS.includes(flag)) {
      const value = arg.startsWith('--') && eq !== -1 ? arg.slice(eq + 1) : argv[++i]
      if (value === undefined || value.startsWith('--')) throw new Error(`${flag} needs a value.`)
      options[flag.slice(2)] = value
    } else throw new Error(`Unknown argument: ${arg}`)
  }
  return options
}

/** The providers table, read from a copy of the database so that a running Cubex is never disturbed. */
function readProviders(dataDir) {
  const db = join(dataDir, 'cubex.db')
  if (!existsSync(db)) throw new Error(`There is no Cubex database at ${db}. Pass --user-data with Cubex's user-data folder.`)
  const copy = mkdtempSync(join(tmpdir(), 'cubex-eval-db-'))
  try {
    for (const suffix of ['', '-wal', '-shm']) if (existsSync(db + suffix)) copyFileSync(db + suffix, join(copy, `cubex.db${suffix}`))
    const Database = require('better-sqlite3')
    const handle = new Database(join(copy, 'cubex.db'), { readonly: false, fileMustExist: true })
    try {
      return handle.prepare('SELECT json FROM providers').all().map((row) => JSON.parse(row.json))
    } finally {
      handle.close()
    }
  } finally {
    try { rmSync(copy, { recursive: true, force: true }) } catch { /* left to the system */ }
  }
}

function pickProvider(providers, wanted) {
  const lower = wanted.toLowerCase()
  const exact = providers.filter((p) => p.id === wanted || String(p.name).toLowerCase() === lower)
  if (exact.length === 1) return exact[0]
  const loose = exact.length ? exact : providers.filter((p) => String(p.name).toLowerCase().includes(lower) || String(p.id).toLowerCase().includes(lower))
  if (loose.length === 1) return loose[0]
  const shown = (loose.length ? loose : providers).map((p) => `  ${p.name}  (id ${p.id}, ${p.kind})`).join('\n')
  throw new Error(`${loose.length ? 'More than one provider matches' : 'No provider matches'} "${wanted}". ${loose.length ? 'Candidates' : 'Saved providers'}:\n${shown || '  (none)'}`)
}

/** Resolve a provider's key the way the app does: the stored ref first, then the per-kind developer variable. */
function resolveKey(cfg, dataDir) {
  const storeFile = join(dataDir, 'credentials.enc.json')
  let entry
  if (cfg.credentialRef && existsSync(storeFile)) {
    try { entry = JSON.parse(readFileSync(storeFile, 'utf8'))[cfg.credentialRef] } catch { entry = undefined }
  }
  if (typeof entry === 'string' && entry.startsWith('env:')) {
    const value = process.env[entry.slice(4)]
    if (value) return value
  } else if (typeof entry === 'string' && entry) {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('This machine cannot decrypt Cubex\'s stored keys (OS encryption is unavailable).')
    try {
      return safeStorage.decryptString(Buffer.from(entry, 'base64'))
    } catch {
      throw new Error('The stored key could not be decrypted. It was saved by a different user or a different Cubex user-data folder: check --user-data.')
    }
  }
  return ENV_KEY_BY_KIND[cfg.kind] ? process.env[ENV_KEY_BY_KIND[cfg.kind]] : undefined
}

/** Pass a child's output on line by line with the key blanked out. */
function scrubbed(stream, target, secret) {
  let tail = ''
  const clean = (text) => (secret ? text.split(secret).join('***') : text)
  stream.on('data', (chunk) => {
    const lines = (tail + chunk.toString('utf8')).split('\n')
    tail = lines.pop() ?? ''
    if (lines.length) target.write(`${clean(lines.join('\n'))}\n`)
  })
  stream.on('end', () => { if (tail) target.write(clean(tail)) })
}

async function main(options, userData) {
  const dataDir = process.env.CUBEX_DATA_DIR && !options['user-data'] ? process.env.CUBEX_DATA_DIR : join(userData, 'cubex-data')

  let providers
  try { providers = readProviders(dataDir) } catch (error) { return fail(error.message) }
  if (options.list) {
    for (const p of providers) console.log(`${p.name}\t${p.id}\t${p.kind}\t${p.baseUrl ?? ''}\t${p.enabled ? 'on' : 'off'}`)
    return app.exit(0)
  }
  if (!options.provider) return fail('Pass --provider "<name or id>" (--list shows the saved ones).')

  let cfg
  let key
  try {
    cfg = pickProvider(providers, options.provider)
    key = resolveKey(cfg, dataDir)
    if (options.kind) cfg = { ...cfg, kind: options.kind }
  } catch (error) { return fail(error.message) }
  if (options.models) {
    // The provider's own model list, for picking --model. Only ids are printed.
    if (!cfg.baseUrl) return fail(`"${cfg.name}" has no base URL to list models from.`)
    try {
      const response = await fetch(`${cfg.baseUrl.replace(/\/+$/, '')}/models`, { headers: key ? { authorization: `Bearer ${key}` } : {} })
      if (!response.ok) return fail(`Listing models failed: HTTP ${response.status}.`)
      const body = await response.json()
      for (const entry of body.data ?? body.models ?? []) console.log(typeof entry === 'string' ? entry : entry.id ?? entry.name)
    } catch (error) { return fail(`Listing models failed: ${error.message}`) }
    return app.exit(0)
  }
  const model = options.model || cfg.defaultModel
  if (!model) return fail(`Pass --model: "${cfg.name}" has no default model.`)
  if (!key && cfg.accessType !== 'local' && !['ollama', 'lmstudio', 'llamacpp'].includes(cfg.kind)) {
    return fail(`"${cfg.name}" has no API key in Cubex (check it in Settings, or the provider may need one).`)
  }

  // Everything about the provider except its secret; the runner adds the key and turns the rest into a ProviderConfig.
  const { credentialRef: _ref, ...publicConfig } = cfg
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  Object.assign(env, {
    CUBEX_EVAL_KIND: cfg.kind,
    CUBEX_EVAL_MODEL: model,
    CUBEX_EVAL_PROVIDER_JSON: JSON.stringify(publicConfig),
    ...(cfg.baseUrl ? { CUBEX_EVAL_BASE_URL: cfg.baseUrl } : {}),
    ...(key ? { CUBEX_EVAL_API_KEY: key } : {}),
    ...(options.tasks ? { CUBEX_EVAL_TASKS: options.tasks } : {}),
    ...(options.repeat ? { CUBEX_EVAL_REPEAT: options.repeat } : {}),
    ...(options.concurrency ? { CUBEX_EVAL_CONCURRENCY: options.concurrency } : {}),
    ...(options.effort ? { CUBEX_EVAL_EFFORT: options.effort } : {}),
    ...(options.keep ? { CUBEX_EVAL_KEEP: '1' } : {})
  })

  console.log(`Provider: ${cfg.name} (${cfg.kind}${cfg.baseUrl ? `, ${cfg.baseUrl}` : ''})\nModel: ${model}\nKey: ${key ? `found (${key.length} characters, not shown)` : 'none needed'}`)
  if (options['dry-run']) return app.exit(0)

  // Resolved the way Node resolves it, so a checkout nested in another (a worktree) uses the parent's install.
  let vitest
  try { vitest = join(dirname(require.resolve('vitest/package.json', { paths: [REPO] })), 'vitest.mjs') } catch { vitest = '' }
  if (!vitest || !existsSync(vitest)) return fail('vitest is not installed here. Run npm install first.')
  // The system node, as `npm run eval` uses: the fixtures' TypeScript tests need a node that strips types.
  const child = spawn('node', [vitest, '-c', 'vitest.eval.config.ts', 'run', 'evals/run.eval.ts'], { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'] })
  scrubbed(child.stdout, process.stdout, key)
  scrubbed(child.stderr, process.stderr, key)
  child.on('error', (error) => fail(`Could not start node: ${error.message}`))
  child.on('close', (code) => app.exit(code ?? 1))
}

// The window state, caches and GPU process of a second Electron on the app's folder are not wanted for a script with no window.
app.disableHardwareAcceleration()
let parsed
let userData
try {
  parsed = parseArgs(process.argv.slice(app.isPackaged ? 1 : 2))
  // The key is decrypted with a key kept in the user-data folder (Chromium's "Local State"), so it has to be the app's own.
  userData = parsed['user-data'] ? resolve(parsed['user-data']) : join(app.getPath('appData'), 'cubex')
  app.setPath('userData', userData)
} catch (error) {
  console.error(`eval:app: ${error.message}`)
  app.exit(2)
}
if (parsed) app.whenReady().then(() => main(parsed, userData)).catch((error) => fail(error.message))
