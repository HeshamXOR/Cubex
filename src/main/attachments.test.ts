import { describe, expect, it } from 'vitest'
import type { AIRequest, MessageContentPart, TextPart } from '@core/types'
import { toChatContentParts, toResponsesContentParts } from '@core/providers/openai/translate'
import { toAnthBlocks } from '@core/providers/anthropic/translate'
import { toOllamaChatBody } from '@core/providers/ollama/OllamaProvider'
import {
  decodeAttachmentText, isSupportedTextAttachment, TEXT_ATTACHMENT_MAX_BYTES,
  TEXT_ATTACHMENT_MAX_FILES, TEXT_ATTACHMENT_TOTAL_MAX_BYTES
} from '@shared/attachmentRules'
import { AttachmentError, normalizeUserAttachments } from './attachments'

const file = (text: string | Buffer, filename = 'notes.md', mediaType = 'application/octet-stream'): MessageContentPart => ({
  type: 'file', filename, source: { kind: 'base64', mediaType, data: Buffer.from(text).toString('base64') }
})

describe('text attachment rules', () => {
  it.each([
    ['source.TSX', 'application/octet-stream'], ['notes.md', ''], ['data.unknown', 'text/plain; charset=utf-8'],
    ['data', 'application/json'], ['Dockerfile', ''], ['.env.local', ''], ['LICENSE', ''], ['diagram.svg', 'image/svg+xml']
  ])('accepts supported text inputs: %s', (name, mime) => {
    expect(isSupportedTextAttachment(name, mime)).toBe(true)
  })

  it.each([
    ['report.pdf', 'application/pdf'], ['report.pdf', 'text/plain'], ['sheet.xlsx', 'application/octet-stream'],
    ['archive.zip', 'text/plain'], ['pretend.txt', 'image/png'], ['pretend.md', 'application/pdf'],
    ['report.rtf', 'text/rtf'], ['unknown', 'application/octet-stream']
  ])('rejects unsupported file formats: %s', (name, mime) => {
    expect(isSupportedTextAttachment(name, mime)).toBe(false)
  })

  it('decodes UTF-8 strictly while preserving text whitespace', () => {
    const text = 'مرحبا\nconst value = "编码"\r\n\t'
    expect(decodeAttachmentText(Buffer.from(text))).toBe(text)
    expect(() => decodeAttachmentText(Buffer.from([0xc3, 0x28]))).toThrow('not valid UTF-8')
  })

  it.each([Buffer.from('a\0b'), Buffer.from([0x01, 0x02]), Buffer.from('%PDF-1.4'), Buffer.from('{\\rtf1 hello}')])(
    'does not present binary/document formats as decoded prose %#', (bytes) => {
      expect(() => decodeAttachmentText(bytes)).toThrow('binary data')
    }
  )
})

describe('attachment normalization', () => {
  it('decodes a source file with filename context and counted provenance', () => {
    const source = file('export const answer = 42\n', 'source.ts')
    const original = structuredClone(source)
    const result = normalizeUserAttachments([source])[0] as TextPart
    expect(result.text).toContain('[Attached text file: "source.ts"]\nexport const answer = 42\n')
    expect(result.attachment).toEqual({ kind: 'text_file', filename: 'source.ts', mediaType: 'application/octet-stream', sizeBytes: 25 })
    expect(source).toEqual(original)
    expect(normalizeUserAttachments([result])[0]).toBe(result)
  })

  it('keeps supported images and ordinary text unchanged', () => {
    const text: MessageContentPart = { type: 'text', text: 'Review this screenshot.' }
    const image: MessageContentPart = { type: 'image', source: { kind: 'base64', mediaType: 'image/png', data: 'AAAA' } }
    const normalized = normalizeUserAttachments([text, image])
    expect(normalized).toEqual([text, image])
    expect(normalized[1]).toBe(image)
  })

  it('accepts empty text files and sanitizes display-only filenames', () => {
    const [part] = normalizeUserAttachments([file('', 'C:\\temp\\hello\nworld.md')]) as TextPart[]
    expect(part!.attachment).toMatchObject({ filename: 'hello world.md', sizeBytes: 0 })
    expect(part!.text).toContain('"hello world.md"')
  })

  it.each(['!', 'YQ', 'YQ=', 'YWJj\n', 'Y===', 'Zh=='])('rejects malformed/noncanonical base64: %s', (data) => {
    const part: MessageContentPart = { type: 'file', filename: 'notes.txt', source: { kind: 'base64', mediaType: 'text/plain', data } }
    expect(() => normalizeUserAttachments([part])).toThrow(/notes.txt.*malformed base64/)
  })

  it('rejects malformed runtime file source data without exposing its payload', () => {
    const part = { type: 'file', filename: 'notes.txt', source: { kind: 'base64', mediaType: 'text/plain', data: 123 } } as unknown as MessageContentPart
    expect(() => normalizeUserAttachments([part])).toThrow(AttachmentError)
    expect(() => normalizeUserAttachments([part])).toThrow('data is missing or malformed')
  })

  it.each<MessageContentPart>([
    file('not extracted', 'report.pdf', 'application/pdf'),
    { type: 'file', filename: 'notes.md', source: { kind: 'url', url: 'https://example.com/private.md' } },
    { type: 'file', filename: 'notes.md', source: { kind: 'file_id', id: 'file-123' } },
    { type: 'image', source: { kind: 'file_id', id: 'image-123' } },
    { type: 'audio', mediaType: 'audio/wav', source: { kind: 'base64', mediaType: 'audio/wav', data: 'AAAA' } },
    { type: 'video', mediaType: 'video/mp4', source: { kind: 'url', url: 'https://example.com/video.mp4' } }
  ])('rejects current unsupported attachments before adapters can discard them %#', (part) => {
    expect(() => normalizeUserAttachments([part])).toThrow(AttachmentError)
  })

  it('rejects invalid UTF-8 and NUL bytes with filename-specific errors', () => {
    expect(() => normalizeUserAttachments([file(Buffer.from([0xff]), 'bad.ts')])).toThrow(/bad.ts.*valid UTF-8/)
    expect(() => normalizeUserAttachments([file('binary\0payload', 'bad.ts')])).toThrow(/bad.ts.*binary data/)
  })

  it('enforces a decoded byte limit, including base64 at the boundary', () => {
    expect(normalizeUserAttachments([file('x'.repeat(TEXT_ATTACHMENT_MAX_BYTES))])[0]).toMatchObject({
      attachment: { sizeBytes: TEXT_ATTACHMENT_MAX_BYTES }
    })
    expect(() => normalizeUserAttachments([file('x'.repeat(TEXT_ATTACHMENT_MAX_BYTES + 1))])).toThrow('256 KiB')
    expect(() => normalizeUserAttachments([file('x'.repeat(TEXT_ATTACHMENT_MAX_BYTES + 3))])).toThrow('256 KiB')
  })

  it('enforces per-message decoded bytes and file count without mutating inputs', () => {
    const full = file('x'.repeat(TEXT_ATTACHMENT_MAX_BYTES))
    const files = Array.from({ length: TEXT_ATTACHMENT_TOTAL_MAX_BYTES / TEXT_ATTACHMENT_MAX_BYTES }, () => full)
    expect(normalizeUserAttachments(files)).toHaveLength(4)
    expect(() => normalizeUserAttachments([...files, file('x')])).toThrow('total 1 MiB')
    expect(normalizeUserAttachments(Array.from({ length: TEXT_ATTACHMENT_MAX_FILES }, () => file('')))).toHaveLength(TEXT_ATTACHMENT_MAX_FILES)
    expect(() => normalizeUserAttachments(Array.from({ length: TEXT_ATTACHMENT_MAX_FILES + 1 }, () => file('')))).toThrow('at most 8')
    expect(full.type).toBe('file')
  })

  it('keeps historical tasks usable with explicit unavailable notes and no binary data', () => {
    const unsupported = file('private binary payload', 'report.pdf', 'application/pdf')
    const result = normalizeUserAttachments([unsupported, file('Readable source', 'source.ts')], { historical: true }) as TextPart[]
    expect(result[0]!.text).toContain('Previous attachment unavailable')
    expect(result[0]!.text).toContain('report.pdf')
    expect(result[0]!.text).toContain('Its contents were not read')
    expect(result[0]!.text).not.toContain('private binary payload')
    expect(result[0]!.attachment).toBeUndefined()
    expect(result[1]!.text).toContain('Readable source')
    expect(result[1]!.attachment?.kind).toBe('text_file')
  })

  it('retains decoded file text in all provider wire translations', () => {
    const content = normalizeUserAttachments([file('const answer = 42', 'answer.ts')])
    const text = (content[0] as TextPart).text
    expect(toChatContentParts(content)).toEqual([{ type: 'text', text }])
    expect(toResponsesContentParts(content)).toEqual([{ type: 'input_text', text }])
    expect(toAnthBlocks(content)).toEqual([{ type: 'text', text }])
    const request: AIRequest = { model: 'test', messages: [{ role: 'user', content }] }
    const ollama = toOllamaChatBody(request, false)
    expect(ollama.messages[0]!.content).toBe(text)
    expect(JSON.stringify(ollama)).not.toContain('sizeBytes')
  })
})
