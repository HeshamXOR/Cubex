import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { makeZip } from './testing/makeZip'
import { crc32, isPlainFile, unixFileType, ZipArchive, ZipError } from './zip'

let dir: string
let counter = 0
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'cubex-zip-')) })
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const archive = (bytes: Buffer): string => {
  const path = join(dir, `a-${++counter}.zip`)
  writeFileSync(path, bytes)
  return path
}
const out = (): string => join(dir, `out-${++counter}`)
const failure = async (work: Promise<unknown>): Promise<ZipError> => {
  const error = await work.then(() => undefined, (caught: unknown) => caught)
  expect(error).toBeInstanceOf(ZipError)
  return error as ZipError
}

const BIG = Buffer.from('the quick brown fox '.repeat(5_000))

describe('the checksum', () => {
  it('is the CRC-32 everyone knows, summed a piece at a time too', () => {
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926)
    expect(crc32(Buffer.alloc(0))).toBe(0)
    expect(crc32(Buffer.from('6789'), crc32(Buffer.from('12345')))).toBe(0xcbf43926)
  })
})

describe('listing an archive', () => {
  it('reads each member\'s name, size and checksum', async () => {
    const zip = await ZipArchive.open(archive(makeZip([{ name: 'a.exe', data: BIG }, { name: 'b.exe', data: Buffer.from('hello'), method: 0 }])))
    expect(zip.entries.map((entry) => [entry.fileName, entry.uncompressedSize, entry.compressionMethod, entry.crc32])).toEqual([
      ['a.exe', BIG.length, 8, crc32(BIG)],
      ['b.exe', 5, 0, crc32(Buffer.from('hello'))]
    ])
    await zip.close()
  })

  it('finds the end of the archive past a comment', async () => {
    const zip = await ZipArchive.open(archive(makeZip([{ name: 'a.exe', data: Buffer.from('x') }], { comment: 'PK\u0005\u0006 made by hand' })))
    expect(zip.entries).toHaveLength(1)
    await zip.close()
  })

  it('knows a plain file from a folder or a link', async () => {
    const zip = await ZipArchive.open(archive(makeZip([
      { name: 'file', data: Buffer.from('x'), attributes: (0o100755 << 16) >>> 0 },
      { name: 'unmarked', data: Buffer.from('x') },
      { name: 'folder/', data: Buffer.alloc(0), method: 0, attributes: 0x10 },
      { name: 'link', data: Buffer.from('target'), attributes: (0o120777 << 16) >>> 0 }
    ])))
    expect(zip.entries.map(isPlainFile)).toEqual([true, true, false, false])
    expect(unixFileType(zip.entries[3]!)).toBe(0o120000)
    await zip.close()
  })

  it.each([
    ['a file that is not an archive', Buffer.from('this is not a zip file at all, just some text')],
    ['a file that is too small', Buffer.from('PK')],
    ['an archive cut short', makeZip([{ name: 'a', data: BIG }]).subarray(0, 40)]
  ])('refuses %s', async (_name, bytes) => {
    await failure(ZipArchive.open(archive(bytes)))
  })

  it('refuses an archive that is split over several files', async () => {
    expect((await failure(ZipArchive.open(archive(makeZip([{ name: 'a', data: Buffer.from('x') }], { disk: 1 }))))).message).toContain('split over several files')
  })

  it('refuses the 64-bit extensions', async () => {
    expect((await failure(ZipArchive.open(archive(makeZip([{ name: 'a', data: Buffer.from('x') }], { total: 0xffff }))))).message).toContain('64-bit')
    const zip = makeZip([{ name: 'a', data: Buffer.from('x') }])
    // The size of the member, in the list of members, set to the marker for "see the extension".
    const marked = Buffer.from(zip)
    marked.writeUInt32LE(0xffffffff, zip.length - 22 - 46 - 1 + 24)
    expect((await failure(ZipArchive.open(archive(marked)))).message).toContain('64-bit')
  })

  it('refuses a list of members that lies outside the file or is not a list', async () => {
    await failure(ZipArchive.open(archive(makeZip([{ name: 'a', data: Buffer.from('x') }], { directoryOffset: 5_000_000 }))))
    const damaged = makeZip([{ name: 'a', data: Buffer.from('x') }])
    damaged.writeUInt32LE(0, damaged.length - 22 - 46 - 1)
    await failure(ZipArchive.open(archive(damaged)))
  })

  it('refuses an archive that says it holds a thousand times what a directory can', async () => {
    await failure(ZipArchive.open(archive(makeZip([{ name: 'a', data: Buffer.from('x') }], { total: 5_000 }))))
  })
})

describe('unpacking a member', () => {
  it('writes a deflated member and a stored one, to the files it is given', async () => {
    const zip = await ZipArchive.open(archive(makeZip([{ name: 'a.exe', data: BIG }, { name: 'b.exe', data: Buffer.from('hello'), method: 0 }])))
    const first = out()
    const second = out()
    await zip.extract(zip.entries[0]!, first)
    await zip.extract(zip.entries[1]!, second, { mode: 0o700 })
    expect(readFileSync(first).equals(BIG)).toBe(true)
    expect(readFileSync(second, 'utf8')).toBe('hello')
    await zip.close()
  })

  it('writes an empty member as an empty file', async () => {
    const zip = await ZipArchive.open(archive(makeZip([{ name: 'empty', data: Buffer.alloc(0), method: 0 }])))
    const file = out()
    await zip.extract(zip.entries[0]!, file)
    expect(readFileSync(file).length).toBe(0)
    await zip.close()
  })

  it('never writes over a file that is there', async () => {
    const zip = await ZipArchive.open(archive(makeZip([{ name: 'a', data: Buffer.from('new') }])))
    const file = out()
    writeFileSync(file, 'precious')
    await failure(zip.extract(zip.entries[0]!, file))
    expect(readFileSync(file, 'utf8')).toBe('precious')
    await zip.close()
  })

  it('refuses a member that is shorter than it says, longer than it says, or fails its checksum', async () => {
    const shorter = await ZipArchive.open(archive(makeZip([{ name: 'a', data: BIG, claim: { uncompressed: BIG.length + 10 } }])))
    expect((await failure(shorter.extract(shorter.entries[0]!, out()))).message).toContain('shorter than it says')
    await shorter.close()
    const longer = await ZipArchive.open(archive(makeZip([{ name: 'a', data: BIG, claim: { uncompressed: BIG.length - 10 } }])))
    expect((await failure(longer.extract(longer.entries[0]!, out()))).message).toContain('longer than it says')
    await longer.close()
    const wrong = await ZipArchive.open(archive(makeZip([{ name: 'a', data: BIG, claim: { crc: 12345 } }])))
    expect((await failure(wrong.extract(wrong.entries[0]!, out()))).message).toContain('failed its checksum')
    await wrong.close()
  })

  it('refuses an empty member that says it is not', async () => {
    const zip = await ZipArchive.open(archive(makeZip([{ name: 'a', data: Buffer.alloc(0), method: 0, claim: { uncompressed: 4 } }])))
    await failure(zip.extract(zip.entries[0]!, out()))
    await zip.close()
  })

  it('refuses an encrypted member and a compression method it has no use for', async () => {
    const encrypted = await ZipArchive.open(archive(makeZip([{ name: 'a', data: Buffer.from('x'), flags: 1 }])))
    expect((await failure(encrypted.extract(encrypted.entries[0]!, out()))).message).toContain('encrypted')
    await encrypted.close()
    const zip = await ZipArchive.open(archive(makeZip([{ name: 'a', data: Buffer.from('x') }])))
    await failure(zip.extract({ ...zip.entries[0]!, compressionMethod: 12 }, out()))
    await zip.close()
  })

  it('refuses a member whose data is outside the file', async () => {
    const zip = await ZipArchive.open(archive(makeZip([{ name: 'a', data: BIG }])))
    const entry = zip.entries[0]!
    await failure(zip.extract({ ...entry, compressedSize: entry.compressedSize + 5_000_000 }, out()))
    await failure(zip.extract({ ...entry, localHeaderOffset: 3 }, out()))
    await zip.close()
    expect(existsSync(dir)).toBe(true)
  })
})
