export type McpArgumentsResult =
  | { ok: true; args: string[] }
  | { ok: false; error: string }

/** Parse arguments without shell splitting, so paths and empty arguments survive unchanged. */
export function parseMcpArguments(input: string): McpArgumentsResult {
  if (input.length > 200_000) {
    return { ok: false, error: 'Arguments input must be 200,000 characters or fewer.' }
  }
  if (!input.trim()) return { ok: true, args: [] }

  let parsed: unknown
  try {
    parsed = JSON.parse(input)
  } catch {
    return { ok: false, error: 'Enter a JSON array of strings, such as ["-y", "package-name"].' }
  }
  if (!Array.isArray(parsed) || parsed.some((argument) => typeof argument !== 'string')) {
    return { ok: false, error: 'Arguments must be a JSON array containing only strings.' }
  }
  if (parsed.length > 64) return { ok: false, error: 'Use 64 arguments or fewer.' }

  let totalLength = 0
  for (const [index, argument] of (parsed as string[]).entries()) {
    if (argument.includes('\0')) {
      return { ok: false, error: `Argument ${index + 1} contains a null character, which cannot be passed to a process.` }
    }
    if (argument.length > 8_192) {
      return { ok: false, error: `Argument ${index + 1} must be 8,192 characters or fewer.` }
    }
    totalLength += argument.length
  }
  if (totalLength > 32_768) {
    return { ok: false, error: 'Arguments must total 32,768 characters or fewer after JSON decoding.' }
  }
  return { ok: true, args: parsed as string[] }
}
