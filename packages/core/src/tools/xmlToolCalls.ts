/**
 * Some models — especially ones served behind a proxy or fine-tuned for another
 * agent harness — emit tool calls as XML *in their text* instead of as native
 * tool_use blocks, e.g.:
 *
 *   <invoke name="fs_read"><parameter name="path">src/app.ts</parameter></invoke>
 *
 * (optionally wrapped in <function_calls>…</function_calls>, and sometimes with
 * an `antml:` prefix). This module recovers those calls so the harness can run
 * them anyway, and strips the raw markup out of anything shown to the user.
 */

export interface ParsedXmlToolCall {
  name: string
  params: Record<string, string>
}

const INVOKE_RE = /<(?:antml:)?invoke\s+name="([^"]+)"\s*>([\s\S]*?)<\/(?:antml:)?invoke>/gi
const PARAM_RE = /<(?:antml:)?parameter\s+name="([^"]+)"\s*>([\s\S]*?)<\/(?:antml:)?parameter>/gi

/** Detect whether text contains any tool-call-style XML markup. */
export function hasXmlToolMarkup(text: string): boolean {
  return /<(?:antml:)?invoke\s+name=|<(?:antml:)?function_calls>/i.test(text)
}

/**
 * Remove fenced code blocks and inline code spans before looking for text tool
 * calls. A model explaining or quoting the format is not asking to run it.
 */
export function stripCodeForToolParsing(text: string): string {
  return text
    .replace(/(^|\n)[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n[ \t]*\2[^\n]*(?=\n|$)|$)/g, '$1')
    .replace(/`[^`\n]*`/g, '')
}

/** Parse every `<invoke>` block into a structured tool call. */
export function parseXmlToolCalls(text: string): ParsedXmlToolCall[] {
  const calls: ParsedXmlToolCall[] = []
  INVOKE_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = INVOKE_RE.exec(text)) !== null) {
    const name = m[1]!.trim()
    const body = m[2] ?? ''
    const params: Record<string, string> = {}
    PARAM_RE.lastIndex = 0
    let p: RegExpExecArray | null
    while ((p = PARAM_RE.exec(body)) !== null) {
      params[p[1]!.trim()] = (p[2] ?? '').trim()
    }
    if (name) calls.push({ name, params })
  }
  return calls
}

export interface MappedToolCall {
  name: string
  input: Record<string, unknown>
}

/**
 * Normalize a parsed XML tool call onto a harness tool. Foreign agent names
 * (fs_read, fs_write, execute_bash, ls, grep, …) are mapped to this harness's
 * tools (list_files/read_file/search_files/write_file). Unknown names pass
 * through unchanged so the executor can report them as unavailable.
 */
export function mapXmlToolCall(parsed: ParsedXmlToolCall, available: Set<string>): MappedToolCall {
  const raw = parsed.name.trim()
  const lower = raw.toLowerCase()
  const p = parsed.params

  if (available.has(raw)) return { name: raw, input: { ...p } }

  if (/^(fs_read|read_file|readfile|cat|view|open_file|open)$/.test(lower)) {
    const path = p.path ?? p.file ?? p.filename ?? p.filePath ?? ''
    const leaf = path.split(/[\\/]/).pop() ?? ''
    // fs_read reads files AND lists directories in some agents — route by shape.
    const looksDir = path === '' || /[\\/]$/.test(path) || !/\.[a-z0-9]{1,8}$/i.test(leaf)
    const name = looksDir && available.has('list_files') ? 'list_files' : 'read_file'
    return { name, input: { path } }
  }
  if (/^(fs_list|list_files|list_directory|listdir|ls|dir|readdir)$/.test(lower)) {
    return { name: 'list_files', input: { path: p.path ?? p.directory ?? p.dir ?? '.' } }
  }
  if (/^(fs_write|write_file|writefile|create_file|save_file|save)$/.test(lower)) {
    return { name: 'write_file', input: { path: p.path ?? p.file ?? p.filename ?? '', content: p.content ?? p.text ?? p.contents ?? '' } }
  }
  if (/^(search|search_files|fs_search|grep|find|ripgrep)$/.test(lower)) {
    return { name: 'search_files', input: { query: p.query ?? p.pattern ?? p.q ?? p.search ?? '', ...(p.path ? { path: p.path } : {}) } }
  }
  return { name: raw, input: { ...p } }
}

/**
 * Remove tool-call XML (and its wrapper tags, including any dangling opener left
 * by a truncated stream) so only human-facing prose remains.
 */
export function stripXmlToolMarkup(text: string): string {
  return text
    .replace(INVOKE_RE, '')
    .replace(/<\/?(?:antml:)?function_calls>/gi, '')
    // A stream cut mid-call can leave an unclosed <invoke ...> opener.
    .replace(/<(?:antml:)?invoke\s+name="[^"]*"\s*>[\s\S]*$/i, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
