import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { LaunchInput, LaunchPlan } from '../../../mcp/resolveLaunch'
import { AntigravityInstaller, type InstallerOptions } from '../install'
import { antigravityProgramNames, type AntigravityReleaseAsset } from '../release'
import { antigravityDirectories, type AntigravityDirectories } from '../profile'
import { configureAntigravity } from '../runtime'
import { makeZip } from './makeZip'

/** The stand-in for Google's runtime, started with Node, and how it is started in place of the real program. */
export const MOCK_AGY = fileURLToPath(new URL('./mockAgy.cjs', import.meta.url))

export const launchMock = ({ args }: LaunchInput): LaunchPlan => ({ file: process.execPath, args: [MOCK_AGY, ...(args ?? [])], windowsVerbatimArguments: false, mode: 'direct' })

const names = antigravityProgramNames()
const MODE = (0o100755 << 16) >>> 0
const EXECUTABLE = Buffer.from(`stand-in runtime\n${'e'.repeat(2_000)}`)
const HARNESS = Buffer.from(`stand-in harness\n${'h'.repeat(1_000)}`)

/** A release the size of a test, and the archive it pins. */
export function testRelease(): { asset: AntigravityReleaseAsset; zip: Buffer } {
  const zip = makeZip([{ name: names.executable, data: EXECUTABLE, attributes: MODE }, { name: names.harness, data: HARNESS, attributes: MODE }])
  return {
    zip,
    asset: {
      version: '1.3.0',
      url: 'https://downloads.example/agy-acp-server.zip',
      sha256: createHash('sha256').update(zip).digest('hex'),
      archiveBytes: zip.length,
      executable: { name: names.executable, bytes: EXECUTABLE.length },
      harness: { name: names.harness, bytes: HARNESS.length }
    }
  }
}

export interface Fixture {
  installer: AntigravityInstaller
  directories: AntigravityDirectories
  helperExecutable: string
}

/** An installer over a folder, and Antigravity set up to use it, with the runtime installed from a download of the test release unless it is not wanted. */
export async function setUpAntigravity(base: string, options: { installed?: boolean; installer?: Partial<InstallerOptions> } = {}): Promise<Fixture> {
  const { asset, zip } = testRelease()
  const installer = new AntigravityInstaller({
    base,
    asset,
    fetch: (async () => new Response(new Uint8Array(zip), { status: 200, headers: { 'content-length': String(zip.length) } })) as typeof fetch,
    validate: async () => undefined,
    freeBytes: () => undefined,
    ...options.installer
  })
  if (options.installed !== false) {
    installer.start()
    await installer.finished()
    if (installer.state.phase !== 'succeeded') throw new Error(`The test install failed: ${installer.state.message ?? installer.state.phase}`)
  }
  const directories = antigravityDirectories(base)
  const fixture: Fixture = { installer, directories, helperExecutable: process.execPath }
  configureAntigravity(fixture)
  return fixture
}
