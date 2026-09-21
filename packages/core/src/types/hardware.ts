/**
 * System profile produced by the hardware analyzer. Fields are optional because
 * detection varies by platform; the estimator degrades gracefully when unknown.
 */

export type GpuVendor = 'nvidia' | 'amd' | 'intel' | 'apple' | 'unknown'

export type AccelerationBackend =
  | 'cuda'
  | 'rocm'
  | 'metal'
  | 'vulkan'
  | 'directml'
  | 'opencl'
  | 'cpu'

export interface CpuInfo {
  model: string
  vendor?: string
  architecture: string
  physicalCores: number
  logicalThreads: number
  baseClockGHz?: number
  /** Detected SIMD/ISA hints (e.g. avx2, avx512, neon). */
  simd?: string[]
}

export interface MemoryInfo {
  totalBytes: number
  availableBytes: number
  /** Estimated bandwidth in GB/s where derivable (affects CPU inference speed). */
  bandwidthGBs?: number
}

export interface GpuInfo {
  model: string
  vendor: GpuVendor
  vramBytes?: number
  sharedMemoryBytes?: number
  driverVersion?: string
  backends: AccelerationBackend[]
}

export interface StorageInfo {
  totalBytes: number
  freeBytes: number
  /** Path used for model storage. */
  modelsDir?: string
  modelsDirFreeBytes?: number
  isSSD?: boolean
}

export interface OsInfo {
  platform: 'win32' | 'linux' | 'darwin' | string
  distro?: string
  release?: string
  arch: string
}

export interface SystemProfile {
  cpu: CpuInfo
  memory: MemoryInfo
  gpus: GpuInfo[]
  storage: StorageInfo
  os: OsInfo
  /** Acceleration backends available anywhere on the system. */
  accelerators: AccelerationBackend[]
  detectedAt: number
}
