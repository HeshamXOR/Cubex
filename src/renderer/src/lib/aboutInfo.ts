import type { AppInfo } from '../../../shared/ipc'

const PLATFORMS: Record<string, string> = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' }

export const platformName = (platform: string): string => PLATFORMS[platform] ?? platform

/** Whether this is an installed build or a checkout being run from source. */
export const buildKind = (info: AppInfo): string => (info.packaged ? 'Installed build' : 'Running from source')

/** "Electron 33.4.0, Chrome 130.0.6723.170, Node 20.18.1", leaving out whatever the build did not report. */
export function runtimeLine(info: AppInfo): string {
  return [['Electron', info.electron], ['Chrome', info.chrome], ['Node', info.node]]
    .filter(([, version]) => version)
    .map(([name, version]) => `${name} ${version}`)
    .join(', ')
}

/** "Windows x64, 10.0.22631". */
export function systemLine(info: AppInfo): string {
  const system = [platformName(info.platform), info.arch].filter(Boolean).join(' ')
  return [system, info.osRelease].filter(Boolean).join(', ')
}

/** What a bug report needs, as plain text for the clipboard. */
export function aboutDetails(info: AppInfo): string {
  return [
    `Cubex ${info.version} (${buildKind(info).toLowerCase()})`,
    runtimeLine(info),
    systemLine(info),
    `Data folder: ${info.dataDir}`,
    `Logs folder: ${info.logsDir}`
  ]
    .filter(Boolean)
    .join('\n')
}
