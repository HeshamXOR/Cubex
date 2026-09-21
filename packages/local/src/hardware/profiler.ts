import os from 'node:os'
import si from 'systeminformation'
import type {
  AccelerationBackend,
  CpuInfo,
  GpuInfo,
  GpuVendor,
  MemoryInfo,
  OsInfo,
  StorageInfo,
  SystemProfile
} from '../../../core/src/types/hardware'

/**
 * Hardware profiler over `systeminformation`, with node `os` fallbacks. Every
 * probe is wrapped so a partial failure still yields a usable SystemProfile —
 * this function never throws.
 */
export async function scanSystem(opts: { modelsDir?: string } = {}): Promise<SystemProfile> {
  const [cpu, memory, gpus, osInfo, storage] = await Promise.all([
    scanCpu(),
    scanMemory(),
    scanGpus(),
    scanOs(),
    scanStorage(opts.modelsDir)
  ])

  const accelerators = new Set<AccelerationBackend>(['cpu'])
  for (const g of gpus) for (const b of g.backends) accelerators.add(b)

  return {
    cpu,
    memory,
    gpus,
    storage,
    os: osInfo,
    accelerators: [...accelerators],
    detectedAt: Date.now()
  }
}

async function scanCpu(): Promise<CpuInfo> {
  const fallback: CpuInfo = {
    model: os.cpus()[0]?.model ?? 'Unknown CPU',
    architecture: os.arch(),
    physicalCores: os.cpus().length,
    logicalThreads: os.cpus().length
  }
  try {
    const c = await si.cpu()
    let simd: string[] | undefined
    try {
      const flags = await si.cpuFlags()
      simd = parseSimd(flags)
    } catch {
      simd = undefined
    }
    return {
      model: `${c.manufacturer} ${c.brand}`.trim() || fallback.model,
      vendor: c.vendor || c.manufacturer,
      architecture: os.arch(),
      physicalCores: c.physicalCores || fallback.physicalCores,
      logicalThreads: c.cores || fallback.logicalThreads,
      ...(c.speed ? { baseClockGHz: c.speed } : {}),
      ...(simd && simd.length ? { simd } : {})
    }
  } catch {
    return fallback
  }
}

function parseSimd(flags: string): string[] {
  const wanted = ['avx512', 'avx2', 'avx', 'sse4_2', 'sse4_1', 'fma', 'neon']
  const lower = flags.toLowerCase()
  return wanted.filter((f) => lower.includes(f))
}

async function scanMemory(): Promise<MemoryInfo> {
  try {
    const m = await si.mem()
    return {
      totalBytes: m.total || os.totalmem(),
      availableBytes: m.available || m.free || os.freemem()
      // bandwidthGBs intentionally omitted — not reliably derivable cross-platform.
    }
  } catch {
    return { totalBytes: os.totalmem(), availableBytes: os.freemem() }
  }
}

function mapVendor(raw: string): GpuVendor {
  const v = raw.toLowerCase()
  if (v.includes('nvidia')) return 'nvidia'
  if (v.includes('amd') || v.includes('advanced micro') || v.includes('radeon')) return 'amd'
  if (v.includes('intel')) return 'intel'
  if (v.includes('apple')) return 'apple'
  return 'unknown'
}

function backendsFor(vendor: GpuVendor, platform: string): AccelerationBackend[] {
  const backends: AccelerationBackend[] = []
  switch (vendor) {
    case 'nvidia':
      backends.push('cuda', 'vulkan')
      if (platform === 'win32') backends.push('directml')
      break
    case 'amd':
      backends.push('rocm', 'vulkan')
      if (platform === 'win32') backends.push('directml')
      break
    case 'intel':
      backends.push('vulkan', 'opencl')
      if (platform === 'win32') backends.push('directml')
      break
    case 'apple':
      backends.push('metal')
      break
    default:
      backends.push('vulkan')
  }
  return backends
}

async function scanGpus(): Promise<GpuInfo[]> {
  const platform = os.platform()
  try {
    const g = await si.graphics()
    const controllers = g.controllers ?? []
    const gpus: GpuInfo[] = controllers
      // Filter out null/empty controllers some drivers report.
      .filter((c) => (c.model && c.model.trim()) || (c.vendor && c.vendor.trim()))
      .map((c) => {
        const vendor = mapVendor(`${c.vendor ?? ''} ${c.model ?? ''}`)
        const vramMb = typeof c.vram === 'number' && c.vram > 0 ? c.vram : undefined
        return {
          model: c.model?.trim() || 'Unknown GPU',
          vendor,
          ...(vramMb ? { vramBytes: vramMb * 1024 * 1024 } : {}),
          ...(c.driverVersion ? { driverVersion: c.driverVersion } : {}),
          backends: backendsFor(vendor, platform)
        }
      })
    return gpus
  } catch {
    return []
  }
}

async function scanOs(): Promise<OsInfo> {
  try {
    const o = await si.osInfo()
    return {
      platform: (o.platform as OsInfo['platform']) || os.platform(),
      ...(o.distro ? { distro: o.distro } : {}),
      ...(o.release ? { release: o.release } : {}),
      arch: o.arch || os.arch()
    }
  } catch {
    return { platform: os.platform(), arch: os.arch() }
  }
}

async function scanStorage(modelsDir?: string): Promise<StorageInfo> {
  try {
    const sizes = await si.fsSize()
    if (!sizes.length) throw new Error('no filesystems')
    // Pick the mount that contains modelsDir if given, else the largest.
    let chosen = sizes[0]!
    if (modelsDir) {
      const match = sizes
        .filter((s) => modelsDir.toLowerCase().startsWith((s.mount ?? '').toLowerCase()))
        .sort((a, b) => (b.mount?.length ?? 0) - (a.mount?.length ?? 0))[0]
      if (match) chosen = match
    } else {
      chosen = sizes.reduce((a, b) => (b.size > a.size ? b : a), sizes[0]!)
    }

    let isSSD: boolean | undefined
    try {
      const layout = await si.diskLayout()
      if (layout.length) isSSD = layout.some((d) => d.type === 'SSD')
    } catch {
      isSSD = undefined
    }

    return {
      totalBytes: chosen.size,
      freeBytes: chosen.available,
      ...(modelsDir ? { modelsDir, modelsDirFreeBytes: chosen.available } : {}),
      ...(isSSD !== undefined ? { isSSD } : {})
    }
  } catch {
    return { totalBytes: 0, freeBytes: 0, ...(modelsDir ? { modelsDir } : {}) }
  }
}
