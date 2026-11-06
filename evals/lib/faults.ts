import { NormalizedAIError } from '@core/types'
import type { AIProvider, AIRequest, AIStreamEvent } from '@core/types'

/**
 * Network trouble on demand, to measure how a turn survives it. CUBEX_EVAL_FAULTS is a comma-separated list, counted in
 * requests the agent makes:
 *
 *   busy:5:4   every 5th request meets a server answering 503 four times in a row, then recovering
 *   cut:7      every 7th request starts its reply, then the connection drops
 *
 * A fault never reaches the wrapped provider, so a real or scripted model is not moved on by a request that failed.
 */
interface Fault {
  kind: 'busy' | 'cut'
  every: number
  times: number
}

function parseFaults(spec: string | undefined): Fault[] {
  return (spec ?? '').split(',').map((part) => part.trim()).filter(Boolean).flatMap((part): Fault[] => {
    const [kind, every, times] = part.split(':')
    if ((kind !== 'busy' && kind !== 'cut') || !Number(every)) return []
    return [{ kind, every: Number(every), times: Number(times) || 1 }]
  })
}

const busy = (): NormalizedAIError =>
  new NormalizedAIError({ provider: 'eval', category: 'SERVER_ERROR', statusCode: 503, message: 'The service is temporarily busy. Please try again shortly.', classification: 'transient', retryable: true })

const dropped = (): Error => Object.assign(new TypeError('terminated'), { cause: { code: 'UND_ERR_SOCKET' } })

export function withFaults(provider: AIProvider): AIProvider {
  const faults = parseFaults(process.env.CUBEX_EVAL_FAULTS)
  if (faults.length === 0) return provider
  let requests = 0
  let busyLeft = 0
  const stream = provider.streamMessage.bind(provider)
  provider.streamMessage = async function* (request: AIRequest, options): AsyncGenerator<AIStreamEvent> {
    if (busyLeft > 0) {
      busyLeft--
      throw busy()
    }
    requests++
    const due = faults.find((fault) => requests % fault.every === 0)
    if (due?.kind === 'busy') {
      busyLeft = due.times - 1
      throw busy()
    }
    if (due?.kind === 'cut') {
      yield { type: 'text_delta', text: 'Working on it' }
      throw dropped()
    }
    yield* stream(request, options)
  }
  return provider
}
