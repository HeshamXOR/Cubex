import { useEffect, useState } from 'react'

/**
 * Live-updating elapsed seconds since `startedAt` (ms). Ticks every `interval` ms
 * while `active`, then freezes. Used by the harness activity indicators.
 */
export function useElapsed(startedAt: number | undefined, active: boolean, interval = 100): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active || startedAt === undefined) return
    setNow(Date.now())
    const id = setInterval(() => setNow(Date.now()), interval)
    return () => clearInterval(id)
  }, [active, startedAt, interval])
  if (startedAt === undefined) return 0
  return Math.max(0, (now - startedAt) / 1000)
}

export function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}m ${s}s`
}
