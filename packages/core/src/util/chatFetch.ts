/**
 * Node's built-in fetch gives up on a request that gets no response headers for five minutes, or no body bytes for
 * five minutes. A chat request can legitimately wait longer than that (a provider that queues requests, a model that
 * thinks quietly), and the limits in Settings decide when waiting is too long. So chat requests opt out of those two
 * built-in limits. Model lists, key checks and downloads keep them.
 */

const UNDICI_GLOBAL_DISPATCHER = Symbol.for('undici.globalDispatcher.1')

type AgentConstructor = new (options: { headersTimeout: number; bodyTimeout: number }) => object

let patient: object | null | undefined

/**
 * undici is bundled inside Node and not importable, but the dispatcher fetch uses is shared on `globalThis` so that
 * copies of undici can interoperate, and its constructor builds another of the same kind. A global dispatcher that is
 * anything but the plain agent (a proxy agent, say) is left alone: replacing it would drop what it does.
 */
function buildPatientDispatcher(): object | null {
  try {
    // Reading a web class loads the bundled undici, which installs the global dispatcher the first time.
    void globalThis.Headers
    const current: unknown = Reflect.get(globalThis, UNDICI_GLOBAL_DISPATCHER)
    const Agent = (current as { constructor?: AgentConstructor } | null | undefined)?.constructor
    if (typeof Agent !== 'function' || Agent.name !== 'Agent') return null
    return new Agent({ headersTimeout: 0, bodyTimeout: 0 })
  } catch {
    return null
  }
}

/**
 * Spread into the init of a chat request's `fetch`: `{ dispatcher }` where the built-in limits can be lifted, nothing
 * where they cannot. It is typed as a plain object because `dispatcher` is an undici option that the DOM `RequestInit`,
 * which the renderer's type check also sees through the providers, does not declare.
 */
export function chatFetchInit(): object {
  patient ??= buildPatientDispatcher()
  return patient ? { dispatcher: patient } : {}
}
