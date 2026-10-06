/**
 * The taskbar badge for sessions that wait on the person: an amber disc with their number, drawn
 * straight into a bitmap so the app ships no image files and needs no native modules.
 */

export const BADGE_SIZE = 32
/** The overlay is 16 device-independent pixels; drawing at twice that keeps it sharp on a 200 percent display. */
export const BADGE_SCALE = 2

/** Digits and a plus in a 5 by 7 grid; a 1 marks a lit pixel. */
const GLYPHS: Record<string, readonly string[]> = {
  '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  '2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  '3': ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  '5': ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  '6': ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  '9': ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
  '+': ['00000', '00100', '00100', '11111', '00100', '00100', '00000']
}

/** Matches --color-warning and its foreground in the dark theme. */
const FILL = { r: 230, g: 169, b: 64 }
const INK = { r: 36, g: 26, b: 2 }

/** What the badge shows: the number, or 9+ from ten up, since two full digits do not fit. */
export function badgeLabel(count: number): string {
  return count > 9 ? '9+' : String(Math.max(0, Math.floor(count)))
}

/** Raw BGRA pixels (premultiplied), the layout Electron's `createFromBitmap` takes on Windows. */
export function renderBadge(count: number): { width: number; height: number; scaleFactor: number; bitmap: Buffer } {
  const size = BADGE_SIZE
  const bitmap = Buffer.alloc(size * size * 4)
  const center = (size - 1) / 2
  const radius = size / 2 - 0.5
  const put = (x: number, y: number, color: { r: number; g: number; b: number }, alpha: number): void => {
    const at = (y * size + x) * 4
    bitmap[at] = Math.round(color.b * alpha)
    bitmap[at + 1] = Math.round(color.g * alpha)
    bitmap[at + 2] = Math.round(color.r * alpha)
    bitmap[at + 3] = Math.round(255 * alpha)
  }
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // A pixel half inside the circle edge is half covered, which smooths the rim.
      const coverage = Math.min(1, Math.max(0, radius + 0.5 - Math.hypot(x - center, y - center)))
      if (coverage > 0) put(x, y, FILL, coverage)
    }
  }
  const label = badgeLabel(count)
  const scale = label.length === 1 ? 3 : 2
  const gap = scale
  const width = label.length * 5 * scale + (label.length - 1) * gap
  const height = 7 * scale
  let left = Math.round((size - width) / 2)
  const top = Math.round((size - height) / 2)
  for (const char of label) {
    const rows = GLYPHS[char]
    if (rows) {
      rows.forEach((row, rowIndex) => {
        for (let col = 0; col < 5; col++) {
          if (row[col] !== '1') continue
          for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) put(left + col * scale + dx, top + rowIndex * scale + dy, INK, 1)
        }
      })
    }
    left += 5 * scale + gap
  }
  return { width: size, height: size, scaleFactor: BADGE_SCALE, bitmap }
}
