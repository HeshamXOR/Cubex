import { CubexMark } from './Logo'
import './mark-anim.css'

export type MarkMotion = 'thinking' | 'planning' | 'working' | 'streaming' | 'idle'

/** The live-turn mark shares the exact brand geometry; static branding is separate. */
export function AnimatedMark({ size = 20, state = 'idle', className = '' }: {
  size?: number
  state?: MarkMotion
  className?: string
}): JSX.Element {
  return <CubexMark size={size} className={`cxmark cxmark--${state} ${className}`} />
}
