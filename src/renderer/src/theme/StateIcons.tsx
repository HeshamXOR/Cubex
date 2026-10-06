import { AlignLeft, Pencil, ShieldQuestion, Terminal, Trash2, type LucideIcon } from 'lucide-react'
import { AnimatedMark } from './AnimatedMark'
import './state-icons.css'

export type ActivityGlyphKind = 'thinking' | 'editing' | 'removing' | 'planning' | 'running' | 'writing' | 'waiting'

interface GlyphProps {
  size?: number
  className?: string
  active?: boolean
}

const GLYPHS: Record<Exclude<ActivityGlyphKind, 'thinking' | 'planning'>, LucideIcon> = {
  editing: Pencil,
  removing: Trash2,
  running: Terminal,
  writing: AlignLeft,
  waiting: ShieldQuestion
}

/**
 * Work in progress is always the Cubex star making quarter turns, whatever the
 * work is. Finished or idle work keeps a still icon for its kind, and a call
 * that waits for the person is the amber shield with a question mark.
 */
export function ActivityGlyph({ kind, size = 16, className = '', active = false }: GlyphProps & { kind: ActivityGlyphKind }): JSX.Element {
  const classes = `activity-glyph activity-glyph--${kind} ${active ? 'is-active' : ''} ${className}`
  if (kind === 'waiting') {
    const Icon = GLYPHS.waiting
    return <Icon className={`${classes} activity-glyph--waiting`} size={size} strokeWidth={1.75} aria-hidden="true" focusable="false" />
  }
  if (active || kind === 'thinking' || kind === 'planning') {
    return <AnimatedMark size={size} state={active ? 'working' : 'idle'} className={classes} />
  }
  const Icon = GLYPHS[kind]
  return <Icon className={classes} size={size} strokeWidth={1.75} aria-hidden="true" focusable="false" />
}

export function CubexThinking(props: GlyphProps): JSX.Element {
  return <ActivityGlyph kind="thinking" {...props} />
}

export function CubexEditing(props: GlyphProps): JSX.Element {
  return <ActivityGlyph kind="editing" {...props} />
}
