import { safeStorage } from 'electron'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dataDir } from './paths'

/**
 * Secure credential storage. Secrets are encrypted with the OS keychain via
 * Electron's `safeStorage` (DPAPI on Windows, Keychain on macOS, libsecret on
 * Linux) and stored as opaque blobs keyed by a `credentialRef`. Provider config
 * only ever stores the ref — never the raw secret.
 *
 * If OS encryption is unavailable (some headless Linux), we fall back to an
 * env-var lookup and refuse to persist plaintext (the ref simply won't resolve).
 */
const STORE_FILE = () => join(dataDir(), 'credentials.enc.json')

type EncStore = Record<string, string> // ref -> base64(ciphertext) or "env:VARNAME"

function loadStore(): EncStore {
  const file = STORE_FILE()
  if (!existsSync(file)) return {}
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as EncStore
  } catch {
    // Keep the damaged file for recovery; the next save must not silently
    // overwrite every other provider's key with an empty store.
    try { renameSync(file, `${file}.corrupt-${Date.now()}`) } catch { /* best effort */ }
    return {}
  }
}

function saveStore(store: EncStore): void {
  // Temp + rename: a crash mid-write leaves the previous file intact.
  const file = STORE_FILE()
  const temp = `${file}.${process.pid}.tmp`
  writeFileSync(temp, JSON.stringify(store, null, 2), { mode: 0o600 })
  renameSync(temp, file)
}

export function encryptionAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

/** Store a secret and return the ref to persist in config. */
export function setSecret(ref: string, secret: string): { ok: boolean; ref: string; message?: string } {
  if (!secret) return { ok: false, ref, message: 'Empty secret' }
  if (!encryptionAvailable()) {
    return {
      ok: false,
      ref,
      message:
        'OS credential encryption is unavailable. Use an environment variable (CUBEX_*) instead; Cubex will not store plaintext secrets.'
    }
  }
  const store = loadStore()
  const cipher = safeStorage.encryptString(secret)
  store[ref] = cipher.toString('base64')
  saveStore(store)
  return { ok: true, ref }
}

/** Bind a ref to an environment variable name (no secret is stored). */
export function setEnvRef(ref: string, varName: string): void {
  const store = loadStore()
  store[ref] = `env:${varName}`
  saveStore(store)
}

/** Resolve a ref to its secret value (decrypting or reading the env var). */
export function getSecret(ref: string | undefined): string | undefined {
  if (!ref) return undefined
  const store = loadStore()
  const entry = store[ref]
  if (!entry) {
    // No stored secret for this ref. Env-var fallbacks are handled explicitly
    // (an `env:` ref below, or ProviderManager's per-kind CUBEX_* vars) — we do
    // NOT treat an arbitrary ref as an env-var name, so a ref that collides with
    // a real variable (PATH, USER, …) can't leak that value as a credential.
    return undefined
  }
  if (entry.startsWith('env:')) {
    return process.env[entry.slice(4)] ?? undefined
  }
  if (!encryptionAvailable()) return undefined
  try {
    return safeStorage.decryptString(Buffer.from(entry, 'base64'))
  } catch {
    return undefined
  }
}

export function deleteSecret(ref: string | undefined): void {
  if (!ref) return
  const store = loadStore()
  if (ref in store) {
    delete store[ref]
    saveStore(store)
  }
}

export function hasSecret(ref: string | undefined): boolean {
  return !!getSecret(ref)
}
