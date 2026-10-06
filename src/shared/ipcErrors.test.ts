import { describe, expect, it } from 'vitest'
import { cleanIpcErrorMessage } from './ipcErrors'

describe('cleanIpcErrorMessage', () => {
  it('drops the channel wrapper and the error class Electron puts in front of the message', () => {
    expect(cleanIpcErrorMessage("Error invoking remote method 'providers:delete': Error: Key store is locked")).toBe('Key store is locked')
  })

  it('handles error subclasses', () => {
    expect(cleanIpcErrorMessage("Error invoking remote method 'local:pull': TypeError: fetch failed")).toBe('fetch failed')
  })

  it('keeps a message that was never wrapped', () => {
    expect(cleanIpcErrorMessage('Enter a valid base URL.')).toBe('Enter a valid base URL.')
  })

  it('keeps the original when nothing is left after the wrapper', () => {
    const wrapped = "Error invoking remote method 'a:b': "
    expect(cleanIpcErrorMessage(wrapped)).toBe(wrapped)
  })

  it('only strips the wrapper at the start of the message', () => {
    const text = "Could not save. Error invoking remote method 'a:b': Error: x"
    expect(cleanIpcErrorMessage(text)).toBe(text)
  })
})
