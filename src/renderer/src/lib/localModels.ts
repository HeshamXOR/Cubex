/**
 * Plain-language names for the identifiers the hardware scanner and the local
 * runtimes report. The scanner and Ollama speak in enums and layer digests;
 * the views should not.
 */

const ACCELERATORS: Record<string, string> = {
  cuda: 'CUDA',
  rocm: 'ROCm',
  metal: 'Metal',
  vulkan: 'Vulkan',
  directml: 'DirectML',
  opencl: 'OpenCL',
  cpu: 'CPU'
}

export function acceleratorLabel(backend: string): string {
  return ACCELERATORS[backend] ?? backend
}

/** GPU backends first, the CPU last. A machine with nothing else says so plainly. */
export function acceleratorSummary(backends: readonly string[]): string {
  const gpu = backends.filter((backend) => backend !== 'cpu')
  if (gpu.length === 0) return 'CPU only'
  return [...gpu, ...(backends.includes('cpu') ? ['cpu'] : [])].map(acceleratorLabel).join(', ')
}

const PLATFORMS: Record<string, string> = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' }

export function platformLabel(platform: string): string {
  return PLATFORMS[platform] ?? platform
}

const BASES: Record<string, string> = {
  theoretical: 'calculated from specs',
  runtime: 'reported by the runtime',
  measured: 'measured on this PC'
}

/** Where an estimate came from, so a guess is never read as a measurement. */
export function basisLabel(basis: string): string {
  return BASES[basis] ?? basis
}

/** Ollama's pull statuses are terse and carry layer digests; name the stage instead. */
export function pullStageLabel(status: string): string {
  const s = status.toLowerCase()
  if (s === 'success') return 'Done'
  if (s === 'cancelled') return 'Cancelled'
  if (s === 'error') return 'Failed'
  if (s.startsWith('pulling manifest') || s.startsWith('preparing')) return 'Preparing'
  if (s.startsWith('verifying')) return 'Verifying'
  if (s.startsWith('writing') || s.startsWith('removing')) return 'Finishing'
  return 'Downloading'
}

/** The time a download has left: 45 s, 3 min, 1 h 5 min. Empty when unknown. */
export function formatEta(seconds: number | undefined): string {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) return ''
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))} s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`
}

const RUNTIMES: Record<string, string> = {
  ollama: 'Ollama',
  lmstudio: 'LM Studio',
  llamacpp: 'llama.cpp',
  'mock-local': 'Offline demo'
}

export function runtimeName(id: string): string {
  return RUNTIMES[id] ?? id
}

/** Main-process errors arrive as `Error: message`; the class name is not for people. */
export function plainError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return text.replace(/^(?:[A-Za-z]*Error): /, '').trim()
}

/** 1st, 2nd, 3rd, 4th, 11th, 12th, 22nd. */
export function ordinal(n: number): string {
  if (n % 100 >= 11 && n % 100 <= 13) return `${n}th`
  const suffix = { 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] ?? 'th'
  return `${n}${suffix}`
}

/**
 * What a download that is waiting says. The runtime reports 1 for the download that is next up;
 * the one already running is first overall, so next up is "2nd".
 */
export function queueLabel(queuePosition: number | undefined): string {
  return queuePosition === undefined ? 'Queued' : `Queued, ${ordinal(queuePosition + 1)}`
}

interface StageSource {
  phase?: string
  status: string
  queuePosition?: number
}

/** The stage a download is in, in words. Prefers the runtime's coarse phase and falls back to its status text. */
export function pullStage(p: StageSource): string {
  switch (p.phase) {
    case 'queued':
      return queueLabel(p.queuePosition)
    case 'preparing':
      return 'Resolving'
    case 'downloading':
      return 'Downloading'
    case 'verifying':
      return 'Verifying'
    case 'finalizing':
      return 'Finishing'
    case 'done':
      return 'Done'
    case 'cancelled':
      return 'Cancelled'
    case 'error':
      return 'Failed'
    default:
      return pullStageLabel(p.status)
  }
}

/** Which file is being fetched when a model is several parts; empty for a single anonymous file. */
export function pullFileLine(p: { fileName?: string; fileIndex?: number; fileCount?: number }): string {
  if (p.fileIndex !== undefined && p.fileCount !== undefined && p.fileCount > 1) {
    return `Part ${p.fileIndex} of ${p.fileCount}${p.fileName ? `, ${p.fileName}` : ''}`
  }
  return p.fileName ?? ''
}

/** What a download says in place of its byte count, which a runtime may not report in every stage. */
export function pullWaitingText(phase: string | undefined): string {
  if (phase === 'verifying') return 'Checking the downloaded files.'
  if (phase === 'finalizing') return 'Saving the model.'
  return 'Checking the model and free disk space.'
}

/** The hint under a download that has stopped receiving bytes. */
export function stalledText(seconds: number): string {
  const idle = formatEta(seconds)
  return `${idle ? `No data received for ${idle}.` : 'No data is arriving.'} Check your connection or cancel and retry.`
}
