import type { FilePart, MessageContentPart, TextPart } from '@core/types'
import {
  decodeAttachmentText, IMAGE_ATTACHMENT_MAX_BYTES, IMAGE_ATTACHMENT_MAX_COUNT, isSupportedTextAttachment, TEXT_ATTACHMENT_MAX_BYTES,
  TEXT_ATTACHMENT_MAX_FILES, TEXT_ATTACHMENT_TOTAL_MAX_BYTES
} from '@shared/attachmentRules'

export class AttachmentError extends Error {
  constructor(filename: string, reason: string) {
    super(`Cannot attach ${JSON.stringify(filename)}: ${reason}`)
    this.name = 'AttachmentError'
  }
}

function displayName(value: unknown, fallback = 'attachment'): string {
  if (typeof value !== 'string') return fallback
  return value.split(/[\\/]/).pop()!.replace(/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, ' ').trim().slice(0, 180) || fallback
}

function decodeFile(part: FilePart): TextPart {
  const filename = displayName(part.filename, 'attachment.txt')
  const source = part.source
  if (!source || source.kind !== 'base64') {
    throw new AttachmentError(filename, 'Only uploaded UTF-8 text files are supported. File URLs and provider file IDs cannot be read here.')
  }
  const mediaType = typeof part.mediaType === 'string' ? part.mediaType : typeof source.mediaType === 'string' ? source.mediaType : ''
  if (!isSupportedTextAttachment(typeof part.filename === 'string' ? part.filename : '', mediaType)) {
    throw new AttachmentError(filename, 'This file format is not supported. Attach UTF-8 text, Markdown, data, or source code; PDF, Office documents, and binary files cannot be read here.')
  }
  if (typeof source.data !== 'string' || source.data.length > 4 * Math.ceil(TEXT_ATTACHMENT_MAX_BYTES / 3)) {
    throw new AttachmentError(filename, typeof source.data === 'string' ? 'Text files must be 256 KiB or smaller.' : 'The attachment data is missing or malformed.')
  }
  // Buffer.from is permissive; require canonical base64 before accepting data.
  if (source.data.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(source.data)) {
    throw new AttachmentError(filename, 'The attachment contains malformed base64 data. Attach the file again.')
  }
  const bytes = Buffer.from(source.data, 'base64')
  if (bytes.toString('base64') !== source.data) {
    throw new AttachmentError(filename, 'The attachment contains malformed base64 data. Attach the file again.')
  }
  let text: string
  try {
    text = decodeAttachmentText(bytes)
  } catch (error) {
    throw new AttachmentError(filename, (error as Error).message)
  }
  return {
    type: 'text',
    text: `[Attached text file: ${JSON.stringify(filename)}]\n${text}\n[End of attached text file: ${JSON.stringify(filename)}]`,
    attachment: { kind: 'text_file', filename, mediaType: mediaType || 'text/plain', sizeBytes: bytes.byteLength }
  }
}

/**
 * Normalize each user message before adapter translation. Historical failures
 * remain visible as unavailable notes, so old unsupported uploads do not block
 * an otherwise usable task. The original saved transcript is never mutated.
 */
export function normalizeUserAttachments(
  content: readonly MessageContentPart[],
  options: { historical?: boolean } = {}
): MessageContentPart[] {
  let bytes = 0
  let files = 0
  let images = 0
  return content.map((part) => {
    try {
      if (part.type === 'file') {
        const decoded = decodeFile(part)
        if (files >= TEXT_ATTACHMENT_MAX_FILES) throw new AttachmentError(decoded.attachment!.filename, 'Attach at most 8 text files per message.')
        if (bytes + decoded.attachment!.sizeBytes > TEXT_ATTACHMENT_TOTAL_MAX_BYTES) {
          throw new AttachmentError(decoded.attachment!.filename, 'Text attachments must total 1 MiB or less per message.')
        }
        bytes += decoded.attachment!.sizeBytes
        files++
        return decoded
      }
      if (part.type === 'audio' || part.type === 'video') {
        throw new AttachmentError(`${part.type} attachment`, `${part.type === 'audio' ? 'Audio' : 'Video'} uploads are not supported by this harness. Attach a text transcript instead.`)
      }
      if (part.type === 'image' && (!part.source || !['base64', 'url'].includes(part.source.kind))) {
        throw new AttachmentError('image', 'This image source is not supported. Upload the image again.')
      }
      if (part.type === 'image') {
        if (++images > IMAGE_ATTACHMENT_MAX_COUNT) throw new AttachmentError('image', `Attach at most ${IMAGE_ATTACHMENT_MAX_COUNT} images per message.`)
        if (part.source.kind === 'base64' && part.source.data.length > 4 * Math.ceil(IMAGE_ATTACHMENT_MAX_BYTES / 3)) {
          throw new AttachmentError('image', `Images must be ${IMAGE_ATTACHMENT_MAX_BYTES / 1024 / 1024} MB or smaller.`)
        }
      }
      return part
    } catch (error) {
      if (!options.historical || !(error instanceof AttachmentError)) throw error
      return { type: 'text', text: `[Previous attachment unavailable. ${error.message} Its contents were not read.]` }
    }
  })
}
