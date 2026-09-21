import { useEffect, useState } from 'react'
import {
  Check,
  CircleAlert,
  Cpu,
  HardDrive,
  MemoryStick,
  MonitorCog,
  RefreshCw,
  Search,
  TriangleAlert,
  X,
  Zap
} from 'lucide-react'
import { api, formatBytes } from '../lib/api'
import type { ModelCompatibility } from '../../../shared/ipc'
import type { CompatibilityStatus, SystemProfile } from '@core/types'

const GOALS = [
  { id: 'general', label: 'General Chat' },
  { id: 'coding', label: 'Coding' },
  { id: 'reasoning', label: 'Reasoning' },
  { id: 'fast', label: 'Fast Responses' },
  { id: 'long_context', label: 'Long Context' },
  { id: 'vision', label: 'Vision' },
  { id: 'low_memory', label: 'Low Memory' },
  { id: 'quality', label: 'Maximum Quality' }
]

const STATUS: Record<CompatibilityStatus, { icon: JSX.Element; label: string; color: string }> = {
  fits_vram: { icon: <Check size={14} />, label: 'Fits in VRAM', color: 'var(--ok)' },
  offload_required: { icon: <TriangleAlert size={14} />, label: 'CPU/RAM offload', color: 'var(--warn)' },
  may_be_slow: { icon: <CircleAlert size={14} />, label: 'May be slow', color: 'var(--warn)' },
  insufficient_memory: { icon: <X size={14} />, label: 'Insufficient memory', color: 'var(--err)' },
  unsupported_runtime: { icon: <X size={14} />, label: 'No compatible runtime', color: 'var(--err)' }
}

export function HardwareView(): JSX.Element {
  const [profile, setProfile] = useState<SystemProfile | null>(null)
  const [scanning, setScanning] = useState(false)
  const [goal, setGoal] = useState('general')
  const [models, setModels] = useState<ModelCompatibility[]>([])
  const [analyzing, setAnalyzing] = useState(false)

  const scan = async (force = false): Promise<void> => {
    setScanning(true)
    setProfile(await api.scanHardware(force))
    setScanning(false)
  }

  const analyze = async (): Promise<void> => {
    setAnalyzing(true)
    setModels(await api.analyzeModels(goal))
    setAnalyzing(false)
  }

  useEffect(() => {
    void scan()
  }, [])

  const gpu = profile?.gpus[0]

  return (
    <div className="view">
      <div className="view__inner">
        <div className="view__title">Hardware Analyzer</div>
        <div className="view__sub">
          Your detected hardware and which local models it can realistically run. Every performance figure is an
          explicit estimate shown as a range and labelled with its basis — never presented as a guarantee.
        </div>

        <div className="row" style={{ justifyContent: 'space-between' }}>
          <div className="h2" style={{ margin: 0 }}>Your system</div>
          <button className="btn btn--ghost" onClick={() => void scan(true)} disabled={scanning}>
            <RefreshCw size={14} className={scanning ? 'spin' : ''} /> {scanning ? 'Scanning…' : 'Re-scan'}
          </button>
        </div>

        {profile && (
          <div className="grid grid--auto" style={{ marginTop: 12, marginBottom: 12 }}>
            <Spec icon={<Cpu size={15} />} title="CPU" main={profile.cpu.model} lines={[
              `${profile.cpu.physicalCores} cores · ${profile.cpu.logicalThreads} threads`,
              profile.cpu.simd?.length ? profile.cpu.simd.join(', ') : profile.cpu.architecture
            ]} />
            <Spec icon={<MemoryStick size={15} />} title="Memory" main={formatBytes(profile.memory.totalBytes)} lines={[
              `${formatBytes(profile.memory.availableBytes)} available`
            ]} />
            <Spec icon={<MonitorCog size={15} />} title="GPU" main={gpu?.model ?? 'None detected'} lines={
              gpu ? [gpu.vramBytes ? `${formatBytes(gpu.vramBytes)} VRAM` : 'VRAM unknown', gpu.backends.join(', ')] : ['CPU inference only']
            } />
            <Spec icon={<HardDrive size={15} />} title="Storage" main={`${formatBytes(profile.storage.freeBytes)} free`} lines={[
              profile.storage.isSSD === true ? 'SSD' : profile.storage.isSSD === false ? 'HDD' : 'Type unknown',
              profile.storage.modelsDir ?? ''
            ]} />
            <Spec icon={<MonitorCog size={15} />} title="OS" main={`${profile.os.distro ?? profile.os.platform}`} lines={[
              `${profile.os.release ?? ''} ${profile.os.arch}`.trim()
            ]} />
            <Spec icon={<Zap size={15} />} title="Acceleration" main={profile.accelerators.join(', ')} lines={[]} />
          </div>
        )}

        <div className="h2">What can I run?</div>
        <div className="row" style={{ marginBottom: 18 }}>
          <select className="select" value={goal} onChange={(e) => setGoal(e.target.value)}>
            {GOALS.map((g) => (
              <option key={g.id} value={g.id}>{g.label}</option>
            ))}
          </select>
          <button className="btn btn--primary" onClick={() => void analyze()} disabled={analyzing}>
            <Search size={15} /> {analyzing ? 'Analyzing…' : 'Analyze My PC'}
          </button>
        </div>

        <div className="grid">
          {models.map((m) => {
            const meta = STATUS[m.status]
            const tps = m.speed.tokensPerSecond
            return (
              <div key={m.model.id} className="card">
                <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div style={{ minWidth: 0 }}>
                    <div className="row">
                      <span style={{ fontWeight: 600 }}>{m.model.displayName}</span>
                      <span className="badge">{m.model.parameterCount}B · {m.model.quantization}</span>
                    </div>
                    <div className="muted" style={{ fontSize: 12.5, marginTop: 6, lineHeight: 1.55 }}>{m.reason}</div>
                  </div>
                  <span className="row" style={{ color: meta.color, fontWeight: 600, fontSize: 12.5, whiteSpace: 'nowrap', gap: 6 }}>
                    {meta.icon} {meta.label}
                  </span>
                </div>
                <div className="row" style={{ marginTop: 14, gap: 24, flexWrap: 'wrap', fontSize: 12.5 }}>
                  <Metric label="Est. memory" value={`${formatBytes(m.memory.totalBytes.low)} – ${formatBytes(m.memory.totalBytes.high)}`} />
                  <Metric
                    label={`Est. speed · ${m.speed.basis} · ${m.speed.confidence} confidence`}
                    value={`${tps.low} – ${tps.high} tok/s`}
                  />
                  <Metric label="Fits on GPU" value={`${Math.round(m.gpuFraction * 100)}%`} />
                </div>
              </div>
            )
          })}
          {models.length === 0 && !analyzing && (
            <div className="empty">Pick a goal and click “Analyze My PC” to see what your hardware can run.</div>
          )}
        </div>
      </div>
    </div>
  )
}

function Spec({ icon, title, main, lines }: { icon: JSX.Element; title: string; main: string; lines: string[] }): JSX.Element {
  return (
    <div className="card">
      <div className="row muted" style={{ fontSize: 11.5, gap: 6 }}>
        {icon}
        {title}
      </div>
      <div style={{ fontWeight: 600, marginTop: 8, fontSize: 13.5 }}>{main}</div>
      {lines.filter(Boolean).map((l, i) => (
        <div key={i} className="muted" style={{ fontSize: 12, marginTop: 3 }}>{l}</div>
      ))}
    </div>
  )
}

function Metric({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div>
      <div className="muted" style={{ fontSize: 11 }}>{label}</div>
      <div style={{ fontWeight: 600, marginTop: 2 }}>{value}</div>
    </div>
  )
}
