import { useEffect, useRef, useState } from 'react'
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
import { compactTokens } from '../lib/format'
import { acceleratorLabel, acceleratorSummary, basisLabel, platformLabel, plainError } from '../lib/localModels'
import type { ModelCompatibility } from '../../../shared/ipc'
import type { CompatibilityStatus, SystemProfile } from '@core/types'

const GOALS = [
  { id: 'general', label: 'General chat' },
  { id: 'coding', label: 'Coding' },
  { id: 'reasoning', label: 'Reasoning' },
  { id: 'fast', label: 'Fast responses' },
  { id: 'long_context', label: 'Long context' },
  { id: 'vision', label: 'Vision' },
  { id: 'low_memory', label: 'Low memory' },
  { id: 'quality', label: 'Maximum quality' }
]

const goalLabel = (id: string): string => GOALS.find((g) => g.id === id)?.label ?? id

const STATUS: Record<CompatibilityStatus, { icon: JSX.Element; label: string; tone: 'ok' | 'warn' | 'err' }> = {
  fits_vram: { icon: <Check size={14} aria-hidden="true" />, label: 'Fits in VRAM', tone: 'ok' },
  offload_required: { icon: <TriangleAlert size={14} aria-hidden="true" />, label: 'Needs CPU and RAM offload', tone: 'warn' },
  may_be_slow: { icon: <CircleAlert size={14} aria-hidden="true" />, label: 'May be slow', tone: 'warn' },
  insufficient_memory: { icon: <X size={14} aria-hidden="true" />, label: 'Not enough memory', tone: 'err' },
  unsupported_runtime: { icon: <X size={14} aria-hidden="true" />, label: 'No compatible runtime', tone: 'err' }
}

export function HardwareView(): JSX.Element {
  const [profile, setProfile] = useState<SystemProfile | null>(null)
  const [scanning, setScanning] = useState(false)
  const [scanError, setScanError] = useState<string | null>(null)
  const [goal, setGoal] = useState('general')
  const [models, setModels] = useState<ModelCompatibility[] | null>(null)
  const [checkedGoal, setCheckedGoal] = useState<string | null>(null)
  const [analyzing, setAnalyzing] = useState(false)
  const [analyzeError, setAnalyzeError] = useState<string | null>(null)
  const mounted = useRef(true)

  const scan = async (force = false): Promise<void> => {
    setScanning(true)
    setScanError(null)
    try {
      const next = await api.scanHardware(force)
      if (mounted.current) setProfile(next)
    } catch (err) {
      if (mounted.current) setScanError(`Could not read this PC's hardware. ${plainError(err)}`)
    } finally {
      if (mounted.current) setScanning(false)
    }
  }

  const analyze = async (): Promise<void> => {
    setAnalyzing(true)
    setAnalyzeError(null)
    try {
      const next = await api.analyzeModels(goal)
      if (mounted.current) {
        setModels(next)
        setCheckedGoal(goal)
      }
    } catch (err) {
      if (mounted.current) setAnalyzeError(`Could not check which models fit. ${plainError(err)}`)
    } finally {
      if (mounted.current) setAnalyzing(false)
    }
  }

  useEffect(() => {
    mounted.current = true
    void scan()
    return () => { mounted.current = false }
  }, [])

  const gpu = profile?.gpus[0]

  return (
    <div className="view">
      <div className="view__inner">
        <h1 className="view__title">Hardware</h1>
        <p className="view__sub">
          Your PC and the local models it can run. Memory and speed are estimates shown as ranges, each labelled with
          where it comes from.
        </p>

        <div className="view__bar">
          <h2 className="h2">Your system</h2>
          <button className="btn btn--ghost" onClick={() => void scan(true)} disabled={scanning}>
            <RefreshCw size={14} aria-hidden="true" /> {scanning ? 'Scanning…' : 'Re-scan'}
          </button>
        </div>

        {scanError && (
          <div className="callout callout--error" role="alert">
            <div className="callout__body">{scanError}</div>
            <button className="callout__action" onClick={() => void scan(true)} disabled={scanning}>Try again</button>
          </div>
        )}
        {!profile && !scanError && <p className="view__note">Scanning your hardware…</p>}

        {profile && (
          <div className="grid grid--auto specs">
            <Spec icon={<Cpu size={15} aria-hidden="true" />} title="CPU" main={profile.cpu.model} lines={[
              profile.cpu.physicalCores > 0 ? `${profile.cpu.physicalCores} cores, ${profile.cpu.logicalThreads} threads` : '',
              profile.cpu.simd?.length ? profile.cpu.simd.map((flag) => flag.toUpperCase()).join(', ') : profile.cpu.architecture
            ]} />
            <Spec icon={<MemoryStick size={15} aria-hidden="true" />} title="Memory" main={formatBytes(profile.memory.totalBytes)} lines={[
              profile.memory.availableBytes > 0 ? `${formatBytes(profile.memory.availableBytes)} available` : ''
            ]} />
            <Spec icon={<MonitorCog size={15} aria-hidden="true" />} title="GPU" main={gpu?.model ?? 'None detected'} lines={
              gpu
                ? [gpu.vramBytes ? `${formatBytes(gpu.vramBytes)} VRAM` : 'VRAM unknown', gpu.backends.map(acceleratorLabel).join(', ')]
                : ['Models will run on the CPU']
            } />
            <Spec icon={<HardDrive size={15} aria-hidden="true" />} title="Storage" main={`${formatBytes(profile.storage.freeBytes)} free`} lines={[
              profile.storage.isSSD === true ? 'SSD' : profile.storage.isSSD === false ? 'HDD' : '',
              profile.storage.modelsDir ?? ''
            ]} />
            <Spec icon={<MonitorCog size={15} aria-hidden="true" />} title="System" main={profile.os.distro ?? platformLabel(profile.os.platform)} lines={[
              [profile.os.release, profile.os.arch].filter(Boolean).join(', ')
            ]} />
            <Spec icon={<Zap size={15} aria-hidden="true" />} title="Acceleration" main={acceleratorSummary(profile.accelerators)} lines={[]} />
          </div>
        )}

        <h2 className="h2">What can I run?</h2>
        <div className="row view__controls">
          <select className="select" value={goal} onChange={(e) => setGoal(e.target.value)} aria-label="What you want to run models for">
            {GOALS.map((g) => (
              <option key={g.id} value={g.id}>{g.label}</option>
            ))}
          </select>
          <button className="btn btn--primary" onClick={() => void analyze()} disabled={analyzing}>
            <Search size={15} aria-hidden="true" /> {analyzing ? 'Checking your PC…' : 'Check my PC'}
          </button>
        </div>

        {analyzeError && (
          <div className="callout callout--error" role="alert">
            <div className="callout__body">{analyzeError}</div>
            <button className="callout__action" onClick={() => void analyze()} disabled={analyzing}>Try again</button>
          </div>
        )}
        {models !== null && checkedGoal !== null && checkedGoal !== goal && !analyzing && (
          <p className="view__note">These results are for {goalLabel(checkedGoal)}. Select Check my PC to update them.</p>
        )}

        <div className="grid">
          {(models ?? []).map((m) => {
            const meta = STATUS[m.status]
            const tps = m.speed.tokensPerSecond
            const memory = m.memory.totalBytes
            const speedKnown = m.status !== 'insufficient_memory' && m.status !== 'unsupported_runtime' && tps.high > 0
            return (
              <article key={m.model.id} className="card fitcard" aria-label={m.model.displayName}>
                <div className="fitcard__head">
                  <div className="fitcard__name">
                    <h3>{m.model.displayName}</h3>
                    {m.model.parameterCount !== undefined && <span className="badge">{m.model.parameterCount}B</span>}
                    {m.model.quantization && <span className="badge">{m.model.quantization}</span>}
                  </div>
                  <span className="fit" data-tone={meta.tone}>
                    {meta.icon}
                    {meta.label}
                    {m.tight && <span className="badge">Tight fit</span>}
                  </span>
                </div>
                <p className="fitcard__reason">{m.reason}</p>
                <dl className="metrics">
                  <Metric label="Estimated memory" value={`${formatBytes(memory.low)} to ${formatBytes(memory.high)}`} note={basisLabel(m.memory.basis)} />
                  {speedKnown && (
                    <Metric
                      label="Estimated speed"
                      value={`${tps.low} to ${tps.high} tok/s`}
                      note={`${m.speed.confidence} confidence, ${basisLabel(m.speed.basis)}`}
                    />
                  )}
                  <Metric label="Share on GPU" value={`${Math.round(m.gpuFraction * 100)}%`} />
                  {m.recommendedContext !== undefined && <Metric label="Context with headroom" value={`${compactTokens(m.recommendedContext)} tokens`} />}
                </dl>
              </article>
            )
          })}
          {models !== null && models.length === 0 && !analyzing && (
            <p className="view__empty">No models matched this goal. Choose another goal and check again.</p>
          )}
          {models === null && !analyzing && !analyzeError && (
            <p className="view__empty">Choose what you want to run, then select Check my PC to see which models fit.</p>
          )}
        </div>
      </div>
    </div>
  )
}

function Spec({ icon, title, main, lines }: { icon: JSX.Element; title: string; main: string; lines: string[] }): JSX.Element {
  return (
    <div className="card spec">
      <div className="spec__title">
        {icon}
        {title}
      </div>
      <div className="spec__main">{main}</div>
      {lines.filter(Boolean).map((line, index) => (
        <div key={index} className="spec__line">{line}</div>
      ))}
    </div>
  )
}

function Metric({ label, value, note }: { label: string; value: string; note?: string }): JSX.Element {
  return (
    <div className="metric">
      <dt>{label}</dt>
      <dd>{value}</dd>
      {note && <dd className="metric__note">{note}</dd>}
    </div>
  )
}
