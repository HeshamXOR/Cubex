import { describe, expect, it } from 'vitest'
import { endpointFailed, endpointsFromList, endpointsNamedInRefusal, isBusyError, preferredEndpoints, withoutVersionPath } from './endpoints'
import { parseGatewayPricing, parseTieredPrice } from './openai-compat/gatewayPricing'

describe('choosing an endpoint for a model', () => {
  it('puts each family on its native format when the server offers it', () => {
    const all = ['chat', 'responses', 'anthropic'] as const
    expect(preferredEndpoints('claude-sonnet-5-5', all)[0]).toBe('anthropic')
    expect(preferredEndpoints('gpt-6.1-sol', all)[0]).toBe('responses')
    expect(preferredEndpoints('o3', all)[0]).toBe('responses')
    expect(preferredEndpoints('deepseek-v4.1-flash', all)[0]).toBe('chat')
    expect(preferredEndpoints('gpt-oss-120b', all)[0]).toBe('chat')
  })

  it('never offers an endpoint the server does not list', () => {
    expect(preferredEndpoints('claude-sonnet-5-5', ['chat'])).toEqual(['chat'])
    expect(preferredEndpoints('minimax-m3.1-flash', ['responses', 'anthropic'])).toEqual(['responses', 'anthropic'])
  })

  it('with no list, tries the Messages API only for Claude', () => {
    expect(preferredEndpoints('claude-opus-5-5')).toEqual(['anthropic', 'chat'])
    expect(preferredEndpoints('gpt-6-sol')).toEqual(['chat'])
    expect(preferredEndpoints('glm-5.3')).toEqual(['chat'])
  })

  it('reads a model list, and tells an image model from a list that says nothing', () => {
    expect(endpointsFromList(['anthropic', 'openai', 'openai-response'])).toEqual(['anthropic', 'chat', 'responses'])
    expect(endpointsFromList(['image-generation'])).toEqual([])
    expect(endpointsFromList(undefined)).toBeUndefined()
  })

  it('reads where a refusal sends the model, in either direction', () => {
    expect(endpointsNamedInRefusal(400, '/v1/chat/completions does not work for this model. Use POST /v1/responses instead.')).toEqual(['responses'])
    expect(endpointsNamedInRefusal(400, 'The model `x` is not available on this endpoint. Use: /v1/chat/completions, /v1/messages.')).toEqual(['chat', 'anthropic'])
    expect(endpointsNamedInRefusal(400, 'max_tokens is too large')).toEqual([])
    expect(endpointsNamedInRefusal(503, 'Use POST /v1/responses instead.')).toEqual([])
  })

  it('counts an overloaded server as busy, by status or by wording', () => {
    expect(isBusyError({ statusCode: 503, message: 'x' })).toBe(true)
    expect(isBusyError({ statusCode: 529, message: 'x' })).toBe(true)
    expect(isBusyError({ statusCode: 500, message: 'The service is temporarily busy. Please try again shortly.' })).toBe(true)
    expect(isBusyError({ statusCode: 400, message: 'bad request' })).toBe(false)
    expect(endpointFailed({ statusCode: 502, message: 'x' })).toBe(true)
  })

  it('finds the root a gateway serves the Messages API from', () => {
    expect(withoutVersionPath('https://app.pizzarouter.xyz/v1')).toBe('https://app.pizzarouter.xyz')
    expect(withoutVersionPath('https://host/api/v1/')).toBe('https://host/api')
  })
})

describe('what a gateway charges', () => {
  it('turns ratios into prices per million tokens', () => {
    const models = parseGatewayPricing({
      group_ratio: { default: 1 },
      data: [{ model_name: 'gpt-5.4', quota_type: 0, model_ratio: 1.25, completion_ratio: 6, cache_ratio: 0.1, create_cache_ratio: 1, supported_endpoint_types: ['openai'], tags: 'chat,reasoning' }]
    })
    expect(models.get('gpt-5.4')).toMatchObject({
      reasoning: true,
      endpoints: ['chat'],
      pricing: { inputPerMTok: 2.5, outputPerMTok: 15, cachedInputPerMTok: 0.25, cacheWritePerMTok: 2.5, source: 'provider' }
    })
  })

  it('applies a group discount, and gives a per-image model no token price', () => {
    const models = parseGatewayPricing({
      group_ratio: { default: 0.5 },
      data: [
        { model_name: 'a', quota_type: 0, model_ratio: 1, completion_ratio: 2 },
        { model_name: 'flux', quota_type: 1, model_price: 0.03, model_ratio: 0 }
      ]
    })
    expect(models.get('a')?.pricing).toMatchObject({ inputPerMTok: 1, outputPerMTok: 2 })
    expect(models.get('flux')?.pricing).toBeUndefined()
  })

  it('reads a tiered price, and refuses anything of another shape', () => {
    const expression = 'len <= 100000 ? tier("standard", p * 0.1 + c * 0.5 + cr * 0.01 + cc * 0.125 + cc1h * 0.2) : tier("long_context", p * 0.5 + c * 2.5 + cr * 0.05 + cc * 0.625)'
    expect(parseTieredPrice(expression)).toMatchObject({
      standard: { inputPerMTok: 0.1, outputPerMTok: 0.5, cachedInputPerMTok: 0.01, cacheWritePerMTok: 0.125 },
      long: { aboveInputTokens: 100_000, inputPerMTok: 0.5, outputPerMTok: 2.5 }
    })
    expect(parseTieredPrice('process.exit(1)')).toBeUndefined()
  })

  it('survives a body that is not a pricing list', () => {
    expect(parseGatewayPricing({ message: 'nope' }).size).toBe(0)
    expect(parseGatewayPricing(null).size).toBe(0)
  })
})
