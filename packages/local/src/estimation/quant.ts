/**
 * Effective bits per weight for common quantizations, averaged over a whole
 * model file. These are measured from published GGUF sizes, not the nominal bit
 * width: k-quants keep some tensors (the output head, attention V) at higher
 * precision and carry per-block scales. Example: Llama 3.1 8B at Q4_K_M is a
 * 4.92 GB file for 8.03 billion weights, which is 4.9 bits per weight.
 * Names are the normalized form (see normalizeQuant).
 */
export const QUANT_BITS_PER_WEIGHT: Readonly<Record<string, number>> = {
  FP32: 32,
  FP16: 16,
  BF16: 16,
  Q8_0: 8.5,
  Q8_1: 9,
  Q8_K_XL: 9,
  Q6_K: 6.56,
  Q6_K_XL: 6.9,
  Q5_K_M: 5.69,
  Q5_K_S: 5.54,
  Q5_K_L: 5.8,
  Q5_K_XL: 5.9,
  Q5_0: 5.5,
  Q5_1: 6,
  Q4_K_M: 4.89,
  Q4_K_S: 4.67,
  Q4_K_L: 5,
  Q4_K_XL: 5,
  Q4_0: 4.55,
  Q4_1: 5,
  IQ4_XS: 4.43,
  IQ4_NL: 4.55,
  Q3_K_L: 4.3,
  Q3_K_M: 4,
  Q3_K_S: 3.64,
  Q3_K_XL: 4.1,
  IQ3_M: 3.77,
  IQ3_S: 3.66,
  IQ3_XS: 3.5,
  IQ3_XXS: 3.2,
  Q2_K: 3.17,
  Q2_K_S: 2.97,
  Q2_K_L: 3.3,
  Q2_K_XL: 3.4,
  IQ2_M: 2.94,
  IQ2_S: 2.78,
  IQ2_XS: 2.6,
  IQ2_XXS: 2.4,
  IQ1_M: 2.1,
  IQ1_S: 1.95,
  MXFP4: 4.25,
  INT8: 8,
  FP8: 8,
  INT4: 4.25,
  AWQ: 4.25,
  GPTQ: 4.25
}

/** Bits per weight assumed when the quantization is unknown: a cautious 5-6 bit average. */
export const UNKNOWN_QUANT_BITS = 5.6

const ALIASES: Readonly<Record<string, string>> = {
  F16: 'FP16',
  F32: 'FP32',
  Q8: 'Q8_0',
  Q6: 'Q6_K',
  Q5: 'Q5_K_M',
  Q5_K: 'Q5_K_M',
  Q4: 'Q4_0',
  Q4_K: 'Q4_K_M',
  Q3_K: 'Q3_K_M',
  Q2: 'Q2_K'
}

/** Upper-case, unify separators, drop the Unsloth `UD-` prefix and map aliases. */
export function normalizeQuant(quant: string | undefined): string | undefined {
  if (!quant) return undefined
  let s = quant.trim().toUpperCase().replace(/-/g, '_').replace(/^UD_/, '')
  if (!s || s === 'UNKNOWN' || s === 'NONE') return undefined
  s = ALIASES[s] ?? s
  return s
}

export function isKnownQuant(quant: string | undefined): boolean {
  const q = normalizeQuant(quant)
  return q !== undefined && q in QUANT_BITS_PER_WEIGHT
}

export function bitsPerWeight(quant: string | undefined): number {
  const q = normalizeQuant(quant)
  return (q !== undefined ? QUANT_BITS_PER_WEIGHT[q] : undefined) ?? UNKNOWN_QUANT_BITS
}
