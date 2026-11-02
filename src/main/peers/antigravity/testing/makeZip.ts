import { deflateRawSync } from 'node:zlib'
import { crc32 } from '../zip'

export interface Member {
  name: string
  data: Buffer
  method?: 0 | 8
  flags?: number
  attributes?: number
  /** What the directory says, when it is not the truth. */
  claim?: { crc?: number; uncompressed?: number; compressed?: number }
}

/** A ZIP written by hand, for what a library would not write on purpose: a member that lies about itself. */
export function makeZip(members: Member[], options: { comment?: string; disk?: number; total?: number; directoryOffset?: number } = {}): Buffer {
  const parts: Buffer[] = []
  const directory: Buffer[] = []
  let offset = 0
  for (const member of members) {
    const method = member.method ?? 8
    const body = method === 8 ? deflateRawSync(member.data) : member.data
    const name = Buffer.from(member.name, 'utf8')
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(member.flags ?? 0, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(crc32(member.data), 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(member.data.length, 22)
    local.writeUInt16LE(name.length, 26)
    parts.push(local, name, body)
    const entry = Buffer.alloc(46)
    entry.writeUInt32LE(0x02014b50, 0)
    entry.writeUInt16LE(20, 4)
    entry.writeUInt16LE(20, 6)
    entry.writeUInt16LE(member.flags ?? 0, 8)
    entry.writeUInt16LE(method, 10)
    entry.writeUInt32LE(member.claim?.crc ?? crc32(member.data), 16)
    entry.writeUInt32LE(member.claim?.compressed ?? body.length, 20)
    entry.writeUInt32LE(member.claim?.uncompressed ?? member.data.length, 24)
    entry.writeUInt16LE(name.length, 28)
    entry.writeUInt32LE(member.attributes ?? 0, 38)
    entry.writeUInt32LE(offset, 42)
    directory.push(entry, name)
    offset += local.length + name.length + body.length
  }
  const central = Buffer.concat(directory)
  const comment = Buffer.from(options.comment ?? '', 'utf8')
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(options.disk ?? 0, 4)
  end.writeUInt16LE(options.total ?? members.length, 8)
  end.writeUInt16LE(options.total ?? members.length, 10)
  end.writeUInt32LE(central.length, 12)
  end.writeUInt32LE(options.directoryOffset ?? offset, 16)
  end.writeUInt16LE(comment.length, 20)
  return Buffer.concat([...parts, central, end, comment])
}
