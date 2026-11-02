import { createReadStream, createWriteStream } from 'node:fs'
import { open, writeFile, type FileHandle } from 'node:fs/promises'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createInflateRaw } from 'node:zlib'

/**
 * A reader for the one kind of ZIP Cubex opens: an archive it has just downloaded and checked against a pinned hash, whose
 * members it knows by name and size. It reads the list of members, refuses anything it has no use for (more than one disk, the
 * 64-bit extensions, encryption, a method other than stored or deflated, a name with a path in it), and unpacks a member to a
 * file it is given with the size and the checksum checked, so a member that is shorter or longer than it says is an error. Nothing
 * in the archive chooses where a file goes.
 */

const END_OF_DIRECTORY = 0x06054b50
const DIRECTORY_ENTRY = 0x02014b50
const LOCAL_HEADER = 0x04034b50
/** The end record is the last 22 bytes, before a comment of up to 65,535 more. */
const END_RECORD_BYTES = 22
const MAX_COMMENT = 0xffff
/** An archive of two programs has a directory of a few hundred bytes; this is for a malformed one. */
const MAX_DIRECTORY_BYTES = 1024 * 1024
const MAX_ENTRIES = 1024

export class ZipError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ZipError'
  }
}

export interface ZipEntry {
  fileName: string
  /** 0 is stored, 8 is deflated. */
  compressionMethod: number
  compressedSize: number
  uncompressedSize: number
  crc32: number
  /** The system that made the archive writes the type and the permissions of the file here. */
  externalFileAttributes: number
  generalPurposeBitFlag: number
  localHeaderOffset: number
}

/** The type of the file the archive says a member is, from the Unix half of its attributes: 0 when it says nothing. */
export function unixFileType(entry: Pick<ZipEntry, 'externalFileAttributes'>): number {
  return (entry.externalFileAttributes >>> 16) & 0o170000
}

const REGULAR_FILE = 0o100000

/** Whether a member is a plain file: not a folder, a link or a device. */
export function isPlainFile(entry: ZipEntry): boolean {
  const type = unixFileType(entry)
  return (type === 0 || type === REGULAR_FILE) && (entry.externalFileAttributes & 0x10) === 0
}

let table: Uint32Array | undefined

function crcTable(): Uint32Array {
  if (table) return table
  table = new Uint32Array(256)
  for (let index = 0; index < 256; index++) {
    let value = index
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    table[index] = value >>> 0
  }
  return table
}

/** The CRC-32 of some bytes, continuing from a value so a stream can be summed a piece at a time. */
export function crc32(data: Uint8Array, previous = 0): number {
  const lookup = crcTable()
  let crc = ~previous >>> 0
  for (const byte of data) crc = lookup[(crc ^ byte) & 0xff]! ^ (crc >>> 8)
  return ~crc >>> 0
}

export class ZipArchive {
  private constructor(private readonly path: string, private readonly handle: FileHandle, readonly entries: readonly ZipEntry[]) {}

  static async open(path: string): Promise<ZipArchive> {
    let handle: FileHandle
    try {
      handle = await open(path, 'r')
    } catch (error) {
      throw new ZipError(`The archive could not be opened: ${error instanceof Error ? error.message : String(error)}`)
    }
    try {
      return new ZipArchive(path, handle, await readDirectory(handle))
    } catch (error) {
      await handle.close().catch(() => undefined)
      throw error
    }
  }

  /**
   * Unpack a member to a new file, which must not exist. The file is the size the member says and the checksum it says, or this
   * fails and the file is left for the caller to remove. A member that claims to be small and is not stops being written as
   * soon as it is longer than it said.
   */
  async extract(entry: ZipEntry, destination: string, options: { mode?: number } = {}): Promise<void> {
    if (entry.compressionMethod !== 0 && entry.compressionMethod !== 8) throw new ZipError('The archive uses a compression method that is not supported.')
    if (entry.generalPurposeBitFlag & 1) throw new ZipError('The archive has an encrypted member.')
    const mode = options.mode ?? 0o600
    const start = await dataStart(this.handle, entry)
    if (entry.compressedSize === 0) {
      if (entry.uncompressedSize !== 0 || entry.crc32 !== 0) throw new ZipError('A member of the archive is empty and says it is not.')
      await writeFile(destination, '', { flag: 'wx', mode })
      return
    }
    let written = 0
    let sum = 0
    const check = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        written += chunk.length
        if (written > entry.uncompressedSize) {
          done(new ZipError('A member of the archive is longer than it says.'))
          return
        }
        sum = crc32(chunk, sum)
        done(null, chunk)
      },
      flush(done) {
        if (written !== entry.uncompressedSize) done(new ZipError('A member of the archive is shorter than it says.'))
        else if (sum !== entry.crc32) done(new ZipError('A member of the archive failed its checksum.'))
        else done()
      }
    })
    const stages: Array<NodeJS.ReadableStream | NodeJS.ReadWriteStream | NodeJS.WritableStream> = [
      // Nothing past the member's own data is read.
      createReadStream(this.path, { start, end: start + entry.compressedSize - 1 }),
      ...(entry.compressionMethod === 8 ? [createInflateRaw()] : []),
      check,
      createWriteStream(destination, { flags: 'wx', mode })
    ]
    try {
      await pipeline(stages)
    } catch (error) {
      if (error instanceof ZipError) throw error
      throw new ZipError(`A member of the archive could not be unpacked: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  async close(): Promise<void> {
    await this.handle.close().catch(() => undefined)
  }
}

async function readExactly(handle: FileHandle, position: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length)
  let read = 0
  while (read < length) {
    const { bytesRead } = await handle.read(buffer, read, length - read, position + read)
    if (bytesRead === 0) throw new ZipError('The archive ends before it should.')
    read += bytesRead
  }
  return buffer
}

async function readDirectory(handle: FileHandle): Promise<ZipEntry[]> {
  const { size } = await handle.stat()
  if (size < END_RECORD_BYTES) throw new ZipError('The file is too small to be an archive.')
  const tailLength = Math.min(size, END_RECORD_BYTES + MAX_COMMENT)
  const tailStart = size - tailLength
  const tail = await readExactly(handle, tailStart, tailLength)
  let record = -1
  for (let index = tail.length - END_RECORD_BYTES; index >= 0; index--) {
    if (tail.readUInt32LE(index) === END_OF_DIRECTORY && index + END_RECORD_BYTES + tail.readUInt16LE(index + 20) === tail.length) {
      record = index
      break
    }
  }
  if (record < 0) throw new ZipError('The file is not an archive: its end record is missing.')
  const disk = tail.readUInt16LE(record + 4)
  const directoryDisk = tail.readUInt16LE(record + 6)
  const onDisk = tail.readUInt16LE(record + 8)
  const total = tail.readUInt16LE(record + 10)
  const directorySize = tail.readUInt32LE(record + 12)
  const directoryOffset = tail.readUInt32LE(record + 16)
  if (disk !== 0 || directoryDisk !== 0 || onDisk !== total) throw new ZipError('The archive is split over several files, which is not supported.')
  if (total === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) throw new ZipError('The archive uses 64-bit extensions, which are not supported.')
  if (total > MAX_ENTRIES || directorySize > MAX_DIRECTORY_BYTES) throw new ZipError('The archive lists more members than it should.')
  if (directoryOffset + directorySize > size) throw new ZipError('The archive\'s list of members is outside the file.')
  const directory = await readExactly(handle, directoryOffset, directorySize)
  const entries: ZipEntry[] = []
  let offset = 0
  for (let index = 0; index < total; index++) {
    if (offset + 46 > directory.length || directory.readUInt32LE(offset) !== DIRECTORY_ENTRY) throw new ZipError('The archive\'s list of members is damaged.')
    const flags = directory.readUInt16LE(offset + 8)
    const nameLength = directory.readUInt16LE(offset + 28)
    const extraLength = directory.readUInt16LE(offset + 30)
    const commentLength = directory.readUInt16LE(offset + 32)
    const next = offset + 46 + nameLength + extraLength + commentLength
    if (next > directory.length) throw new ZipError('The archive\'s list of members is damaged.')
    const compressedSize = directory.readUInt32LE(offset + 20)
    const uncompressedSize = directory.readUInt32LE(offset + 24)
    const localHeaderOffset = directory.readUInt32LE(offset + 42)
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localHeaderOffset === 0xffffffff) throw new ZipError('The archive uses 64-bit extensions, which are not supported.')
    entries.push({
      fileName: directory.toString(flags & 0x800 ? 'utf8' : 'latin1', offset + 46, offset + 46 + nameLength),
      generalPurposeBitFlag: flags,
      compressionMethod: directory.readUInt16LE(offset + 10),
      crc32: directory.readUInt32LE(offset + 16),
      compressedSize,
      uncompressedSize,
      externalFileAttributes: directory.readUInt32LE(offset + 38),
      localHeaderOffset
    })
    offset = next
  }
  return entries
}

/** Where a member's data starts: after its own header, which has its own lengths of name and extra data. */
async function dataStart(handle: FileHandle, entry: ZipEntry): Promise<number> {
  const header = await readExactly(handle, entry.localHeaderOffset, 30)
  if (header.readUInt32LE(0) !== LOCAL_HEADER) throw new ZipError('A member of the archive has a damaged header.')
  const start = entry.localHeaderOffset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28)
  const { size } = await handle.stat()
  if (start + entry.compressedSize > size) throw new ZipError('A member of the archive is outside the file.')
  return start
}
