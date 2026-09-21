/**
 * Cubex brand mark — a four-pointed compass star, traced from the official logo.
 *
 * Structure (100×100 viewBox, centre 50,50):
 *   • four CARDINAL blades (N/S/E/W): long slender spikes with slightly concave
 *     sides, needle-thin at the tip, ~7 units wide at the base, stopping just
 *     short of the centre so a small X-gap shows through.
 *   • four DIAGONAL needles (NE/NW/SE/SW): thinner spikes reaching ~2/3 of the
 *     way to each corner.
 * The diagonals are drawn a touch lighter, exactly as in the source art.
 */

// Cardinal blade: sharp tip near the edge, sides bow out (convex) to a wide base
// just short of centre, leaving a small diamond gap at (50,50).
const BLADE_N = 'M50 5 Q49 30 45.8 47.2 L50 50 L54.2 47.2 Q51 30 50 5 Z'
const BLADE_S = 'M50 95 Q51 70 54.2 52.8 L50 50 L45.8 52.8 Q49 70 50 95 Z'
const BLADE_E = 'M95 50 Q70 49 52.8 45.8 L50 50 L52.8 54.2 Q70 51 95 50 Z'
const BLADE_W = 'M5 50 Q30 51 47.2 54.2 L50 50 L47.2 45.8 Q30 49 5 50 Z'

// Diagonal needles — slimmer spikes reaching ~2/3 toward each corner.
const NEEDLE_NE = 'M75 25 Q58 38 54 46 L52.5 44.5 Q58 32 75 25 Z'
const NEEDLE_NW = 'M25 25 Q42 38 46 46 L47.5 44.5 Q42 32 25 25 Z'
const NEEDLE_SE = 'M75 75 Q58 62 54 54 L52.5 55.5 Q58 68 75 75 Z'
const NEEDLE_SW = 'M25 75 Q42 62 46 54 L47.5 55.5 Q42 68 25 75 Z'

export interface LogoProps {
  size?: number
  gradient?: boolean
  glow?: boolean
  className?: string
}

export function CubexMark({ size = 24, gradient = false, glow = false, className }: LogoProps): JSX.Element {
  const gid = `cx-${size}-${gradient ? 'g' : 'p'}`
  const fill = gradient ? `url(#${gid})` : 'currentColor'
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      style={glow ? { filter: 'drop-shadow(0 0 16px rgba(120,140,255,0.4))' } : undefined}
      aria-hidden
    >
      {gradient && (
        <defs>
          <linearGradient id={gid} x1="12" y1="12" x2="88" y2="88" gradientUnits="userSpaceOnUse">
            <stop stopColor="#9db0ff" />
            <stop offset="0.5" stopColor="#ffffff" />
            <stop offset="1" stopColor="#c3a8ff" />
          </linearGradient>
        </defs>
      )}
      <path d={`${BLADE_N} ${BLADE_S} ${BLADE_E} ${BLADE_W}`} fill={fill} />
      <path d={`${NEEDLE_NE} ${NEEDLE_NW} ${NEEDLE_SE} ${NEEDLE_SW}`} fill={fill} opacity={0.9} />
    </svg>
  )
}

/**
 * The "CUB≡X" wordmark: the brand E is three stacked bars with no vertical stem,
 * so it's drawn as a small inline SVG between the letterforms.
 */
export function CubexWordmark({
  size = 15,
  tagline = false,
  className
}: {
  size?: number
  tagline?: boolean
  className?: string
}): JSX.Element {
  const barH = size * 0.6
  return (
    <span className={className} style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'center', gap: size * 0.4 }}>
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: size * 0.3,
          fontSize: size,
          fontWeight: 500,
          letterSpacing: size * 0.2,
          lineHeight: 1,
          textIndent: size * 0.2,
          color: 'inherit'
        }}
      >
        CUB
        <svg width={barH} height={barH} viewBox="0 0 10 10" fill="none" aria-hidden>
          <rect x="0" y="1.2" width="10" height="1.5" rx="0.3" fill="currentColor" />
          <rect x="0" y="4.25" width="10" height="1.5" rx="0.3" fill="currentColor" />
          <rect x="0" y="7.3" width="10" height="1.5" rx="0.3" fill="currentColor" />
        </svg>
        X
      </span>
      {tagline && (
        <span
          style={{
            fontSize: size * 0.26,
            letterSpacing: size * 0.16,
            color: 'var(--text-3)',
            fontWeight: 400,
            textIndent: size * 0.16
          }}
        >
          INTELLIGENCE. OPEN. LIMITLESS.
        </span>
      )}
    </span>
  )
}

/** Horizontal lockup for the sidebar header. */
export function CubexLockup({ size = 22 }: { size?: number }): JSX.Element {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: size * 0.5, color: 'var(--text-0)' }}>
      <CubexMark size={size * 1.3} />
      <CubexWordmark size={size * 0.8} />
    </span>
  )
}
