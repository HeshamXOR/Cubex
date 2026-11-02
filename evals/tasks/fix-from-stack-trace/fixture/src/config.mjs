/**
 * Config files are "key = value" lines. Blank lines and lines starting with # are ignored.
 *
 *   port = 8080
 *   allowed_hosts = example.com, api.example.com
 */

const DEFAULTS = { port: 3000, allowedHosts: [], logLevel: 'info' }

/** Splits "a, b ,c" into ["a", "b", "c"], dropping empty items. */
function parseList(value) {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

function parseLines(text) {
  const values = {}
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq === -1) throw new Error(`bad config line: ${line}`)
    values[line.slice(0, eq).trim()] = line.slice(eq + 1).trim()
  }
  return values
}

export function loadConfig(text) {
  const values = parseLines(text)
  return {
    port: values.port === undefined ? DEFAULTS.port : Number(values.port),
    allowedHosts: parseList(values.allowed_hosts),
    logLevel: values.log_level ?? DEFAULTS.logLevel
  }
}
