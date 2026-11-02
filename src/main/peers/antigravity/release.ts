/**
 * Google's Antigravity ACP runtime: the release Cubex installs, one archive per platform. The links are the ones the Agent
 * Client Protocol registry publishes for Antigravity (agentclientprotocol/registry, antigravity-acp/agent.json). The sizes and
 * the SHA-256 of each archive come from the T3 Code project (github.com/pingdotgg/t3code, MIT licence, Copyright (c) 2026
 * T3 Tools Inc.), which checked them on 2026-10-05; see THIRD_PARTY_NOTICES.md. Nothing is installed from a download that does
 * not match them to the byte, so a wrong number here makes an install fail and never makes it unsafe.
 *
 * The runtime is Google's software and is used under Google's terms (https://antigravity.google/terms). Cubex downloads it
 * from Google's own host, only when the person asks, and never redistributes it.
 */

export const ANTIGRAVITY_RELEASE_VERSION = '1.3.0'
export const ANTIGRAVITY_TERMS_URL = 'https://antigravity.google/terms'

export interface AntigravityReleaseAsset {
  version: string
  url: string
  /** Of the archive, as a download gives it. */
  sha256: string
  archiveBytes: number
  /** The runtime: it speaks the protocol. */
  executable: { name: string; bytes: number }
  /** The program the runtime starts for the model's work; it sits beside the runtime. */
  harness: { name: string; bytes: number }
}

const RELEASE_ASSETS: ReadonlyMap<string, AntigravityReleaseAsset> = new Map([
  ['darwin-arm64', {
    version: ANTIGRAVITY_RELEASE_VERSION,
    url: 'https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-1.3.0-darwin-arm64.zip',
    sha256: '7cd97045f7b4fe81175a107cdf16f9c51484e3c78a5162cae415338bb6aa5b88',
    archiveBytes: 111_456_962,
    executable: { name: 'agy_acp_server.par', bytes: 278_535_456 },
    harness: { name: 'localharness_external', bytes: 118_611_392 }
  }],
  ['darwin-x64', {
    version: ANTIGRAVITY_RELEASE_VERSION,
    url: 'https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-1.3.0-darwin-x86_64.zip',
    sha256: 'bb23956b89984bf5d354af2c3725e6c57f0cc1b7228e77a0e91c9c2bc1d47646',
    archiveBytes: 117_245_544,
    executable: { name: 'agy_acp_server.par', bytes: 282_840_688 },
    harness: { name: 'localharness_external', bytes: 124_175_392 }
  }],
  ['linux-x64', {
    version: ANTIGRAVITY_RELEASE_VERSION,
    url: 'https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-1.3.0-linux-x86_64.zip',
    sha256: '9fb60956af0a9d76220a4db91ca9ac88e2a2372ad68f985ab5fceace6b825b96',
    archiveBytes: 333_727_150,
    executable: { name: 'agy_acp_server.par', bytes: 926_533_965 },
    harness: { name: 'localharness_external', bytes: 130_388_040 }
  }],
  ['linux-arm64', {
    version: ANTIGRAVITY_RELEASE_VERSION,
    url: 'https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-1.3.0-linux-arm64.zip',
    sha256: '500b0bc0fb858e88f4df404d4cedf80bf9298c178291e39e383d6c50b111cbdf',
    archiveBytes: 321_690_363,
    executable: { name: 'agy_acp_server.par', bytes: 930_848_992 },
    harness: { name: 'localharness_external', bytes: 123_224_968 }
  }],
  ['win32-x64', {
    version: ANTIGRAVITY_RELEASE_VERSION,
    url: 'https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-1.3.0-windows-x86_64.zip',
    sha256: '65215e0688681fa3116e048a9eab27ef53af1bbd6f3da3f1c52bd4911d8b17f9',
    archiveBytes: 124_509_787,
    executable: { name: 'agy_acp_server.exe', bytes: 81_437_336 },
    harness: { name: 'localharness_external.exe', bytes: 145_548_952 }
  }],
  ['win32-arm64', {
    version: ANTIGRAVITY_RELEASE_VERSION,
    url: 'https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-1.3.0-windows-arm64.zip',
    sha256: '4a0f469720e9beb9438a979f543fdbfad5022ebe0992c052c590bd78b3144ca3',
    archiveBytes: 124_654_803,
    executable: { name: 'agy_acp_server.exe', bytes: 85_893_472 },
    harness: { name: 'localharness_external.exe', bytes: 135_640_216 }
  }]
])

/** The release for this platform, or null when Google publishes none (a 32-bit system, FreeBSD). */
export function resolveAntigravityReleaseAsset(platform: NodeJS.Platform = process.platform, arch: string = process.arch): AntigravityReleaseAsset | null {
  return RELEASE_ASSETS.get(`${platform}-${arch}`) ?? null
}

/** The names of the two programs on a platform, whether or not Google publishes a release for it. */
export function antigravityProgramNames(platform: NodeJS.Platform = process.platform): { executable: string; harness: string } {
  return platform === 'win32'
    ? { executable: 'agy_acp_server.exe', harness: 'localharness_external.exe' }
    : { executable: 'agy_acp_server.par', harness: 'localharness_external' }
}

/** What an install needs on disk: the archive, what it unpacks to, and room to spare. */
export const ANTIGRAVITY_FREE_SPACE_MARGIN = 256 * 1024 * 1024

export function antigravityInstallBytes(asset: AntigravityReleaseAsset): number {
  return asset.archiveBytes + asset.executable.bytes + asset.harness.bytes + ANTIGRAVITY_FREE_SPACE_MARGIN
}
