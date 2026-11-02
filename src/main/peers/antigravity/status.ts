import type { AntigravityInstallState, AntigravitySignInState, AntigravityStatus } from '@shared/antigravity'
import { hasSavedSignIn } from './profile'
import { ANTIGRAVITY_TERMS_URL, type AntigravityReleaseAsset } from './release'

/** What the Settings page is told about Antigravity: whether Google has a runtime for this computer, what is installed, who is signed in. */

export interface StatusInput {
  /** The release Cubex would install here, or null when Google publishes none. */
  asset: AntigravityReleaseAsset | null
  runtime: AntigravityInstallState
  signIn: AntigravitySignInState
  /** The runtime's profile folder, where it saves the sign-in. Only asked whether the file is there. */
  profileDirectory: string
  desktopApp: boolean
  localOnly: boolean
}

export function antigravityStatus(input: StatusInput): AntigravityStatus {
  const { asset } = input
  return {
    supported: asset !== null,
    desktopApp: input.desktopApp,
    runtime: input.runtime,
    signedIn: hasSavedSignIn(input.profileDirectory),
    signIn: input.signIn,
    downloadBytes: asset ? asset.archiveBytes : null,
    diskBytes: asset ? asset.executable.bytes + asset.harness.bytes : null,
    termsUrl: ANTIGRAVITY_TERMS_URL,
    localOnly: input.localOnly
  }
}
