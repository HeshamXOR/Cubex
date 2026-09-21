import './mark-anim.css'

/**
 * The Cubex compass-star, purpose-built as a *motion* mark for harness activity
 * states — NOT an icon. The four cardinal blades light up in a clockwise sweep
 * (N→E→S→W), the diagonal needles rotate slowly, and the whole mark breathes a
 * soft glow. It's the brand logo, alive.
 *
 * `state` tunes the tempo:
 *   thinking  — contemplative sweep
 *   working   — faster, tighter
 *   streaming — quick pulse while tokens flow
 */
export type MarkMotion = 'thinking' | 'working' | 'streaming' | 'idle'

const BLADE = {
  N: 'M50 5 Q49 30 45.8 47.2 L50 50 L54.2 47.2 Q51 30 50 5 Z',
  E: 'M95 50 Q70 49 52.8 45.8 L50 50 L52.8 54.2 Q70 51 95 50 Z',
  S: 'M50 95 Q51 70 54.2 52.8 L50 50 L45.8 52.8 Q49 70 50 95 Z',
  W: 'M5 50 Q30 51 47.2 54.2 L50 50 L47.2 45.8 Q30 49 5 50 Z'
}
const NEEDLES =
  'M75 25 Q58 38 54 46 L52.5 44.5 Q58 32 75 25 Z ' +
  'M25 25 Q42 38 46 46 L47.5 44.5 Q42 32 25 25 Z ' +
  'M75 75 Q58 62 54 54 L52.5 55.5 Q58 68 75 75 Z ' +
  'M25 75 Q42 62 46 54 L47.5 55.5 Q42 68 25 75 Z'

export function AnimatedMark({
  size = 20,
  state = 'thinking'
}: {
  size?: number
  state?: MarkMotion
}): JSX.Element {
  const gid = `cxa-${size}`
  return (
    <svg
      className={`cxmark cxmark--${state}`}
      width={size}
      height={size}
      viewBox="0 0 100 100"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
    >
      <defs>
        <linearGradient id={gid} x1="10" y1="10" x2="90" y2="90" gradientUnits="userSpaceOnUse">
          <stop stopColor="#9db0ff" />
          <stop offset="0.5" stopColor="#ffffff" />
          <stop offset="1" stopColor="#c3a8ff" />
        </linearGradient>
      </defs>
      {/* Diagonal needles — slow rotation */}
      <path className="cxmark__needles" d={NEEDLES} fill={`url(#${gid})`} />
      {/* Cardinal blades — clockwise sweep */}
      <path className="cxmark__blade cxmark__blade--n" d={BLADE.N} fill={`url(#${gid})`} />
      <path className="cxmark__blade cxmark__blade--e" d={BLADE.E} fill={`url(#${gid})`} />
      <path className="cxmark__blade cxmark__blade--s" d={BLADE.S} fill={`url(#${gid})`} />
      <path className="cxmark__blade cxmark__blade--w" d={BLADE.W} fill={`url(#${gid})`} />
    </svg>
  )
}
