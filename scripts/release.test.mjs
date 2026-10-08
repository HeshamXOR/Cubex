import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { GITHUB_FEED } from '../src/main/updates/feed'
import { parseRelease } from '../src/main/updates/releases'
import { UPDATE_NOTES_END } from '../src/shared/updates'
import { NOTES_END, describeInstaller, findSection, isDate, recordedDigest, releaseBody, releaseProblems, versionOfTag } from './release.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const script = join(root, 'scripts', 'release.mjs')
const changelogFile = readFileSync(join(root, 'CHANGELOG.md'), 'utf8')

const CHANGELOG = [
  '# Changelog',
  '',
  'Intro with a ## in the middle of a line.',
  '',
  '## [Unreleased]',
  '',
  'Nothing yet.',
  '',
  '## [0.2.0] - 2026-10-20',
  '',
  'A short summary.',
  '',
  '### New',
  '',
  '- **Other agents.** Ask another agent.',
  '',
  '## [0.1.0] - 2026-10-07',
  '',
  'The first release.',
  ''
].join('\n')

const ready = { tag: 'v0.2.0', packageVersion: '0.2.0', lockVersions: [['version', '0.2.0'], ['packages[""]', '0.2.0']], changelog: CHANGELOG }

describe('versionOfTag', () => {
  it.each(['v0.2.0', 'v10.20.30', 'v1.0.0'])('reads %s', (tag) => {
    expect(versionOfTag(tag)).toBe(tag.slice(1))
  })

  it.each(['0.2.0', 'v1.2', 'v1.2.3.4', 'v1.2.3-beta.1', 'v01.2.3', 'V1.2.3', 'v1.2.3 ', ' v1.2.3', 'v1.2.x', '', 'main', 'v1.2.3\nv4.5.6'])('does not read %j', (tag) => {
    expect(versionOfTag(tag)).toBeUndefined()
  })
})

describe('isDate', () => {
  it('takes a calendar date as YYYY-MM-DD', () => {
    expect(isDate('2026-10-20')).toBe(true)
    expect(isDate('2028-02-29')).toBe(true)
  })

  it.each(['Unreleased', '', '2026-2-3', '2026-02-30', '2027-02-29', '2026-13-01', '2026-10-20 ', '20261020', '2026/10/20'])('does not take %j', (text) => {
    expect(isDate(text)).toBe(false)
  })
})

describe('findSection', () => {
  it('finds a version, its date and its text up to the next version', () => {
    const section = findSection(CHANGELOG, '0.2.0')
    expect(section).toEqual({
      heading: '## [0.2.0] - 2026-10-20',
      date: '2026-10-20',
      body: 'A short summary.\n\n### New\n\n- **Other agents.** Ask another agent.'
    })
    expect(findSection(CHANGELOG, '0.1.0')?.body).toBe('The first release.')
  })

  it('reads a heading without brackets, with a v, or without a date', () => {
    expect(findSection('## 0.3.0\n\ntext', '0.3.0')).toEqual({ heading: '## 0.3.0', date: '', body: 'text' })
    expect(findSection('## [v0.3.0] - 2026-11-01\n\ntext', '0.3.0')?.date).toBe('2026-11-01')
    expect(findSection('## [0.3.0] - Unreleased\n\ntext', '0.3.0')?.date).toBe('Unreleased')
  })

  it('does not take the Unreleased heading for a version, and ends a section at it', () => {
    expect(findSection(CHANGELOG, 'Unreleased')).toBeUndefined()
    expect(findSection('## [0.2.0] - 2026-10-20\n\ntext\n\n## [Unreleased]\n\nlater', '0.2.0')?.body).toBe('text')
  })

  it('does not take 0.2.0 for 10.2.0 or 0.2.01', () => {
    expect(findSection('## [10.2.0] - 2026-10-20\n\ntext', '0.2.0')).toBeUndefined()
    expect(findSection('## [0.2.01] - 2026-10-20\n\ntext', '0.2.0')).toBeUndefined()
  })

  it('reads the last section to the end of the file, and any line ending', () => {
    expect(findSection('## [0.1.0] - 2026-10-07\r\n\r\nline one\r\nline two\r\n', '0.1.0')?.body).toBe('line one\nline two')
  })

  it('is undefined for a version the changelog does not have', () => {
    expect(findSection(CHANGELOG, '9.9.9')).toBeUndefined()
    expect(findSection('', '0.2.0')).toBeUndefined()
  })
})

describe('releaseProblems', () => {
  it('has nothing to say about a release that is ready', () => {
    expect(releaseProblems(ready)).toEqual([])
  })

  it('refuses a tag that is not a version', () => {
    const [problem, ...more] = releaseProblems({ ...ready, tag: 'v0.2.0-beta.1' })
    expect(problem).toMatch(/not a release tag/)
    expect(more).toEqual([])
  })

  it('says when package.json is for another version, and what to run', () => {
    const [problem] = releaseProblems({ ...ready, packageVersion: '0.1.0' })
    expect(problem).toMatch(/package\.json says version 0\.1\.0, and the tag is for 0\.2\.0/)
    expect(problem).toContain('npm version 0.2.0 --no-git-tag-version')
  })

  it('says which place in package-lock.json is for another version', () => {
    const problems = releaseProblems({ ...ready, lockVersions: [['version', '0.2.0'], ['packages[""]', '0.1.0']] })
    expect(problems).toHaveLength(1)
    expect(problems[0]).toMatch(/package-lock\.json \(packages\[""\]\) says 0\.1\.0, not 0\.2\.0/)
  })

  it('wants a section for the version, with the Unreleased heading renamed', () => {
    const [problem] = releaseProblems({ ...ready, changelog: CHANGELOG.replace('## [0.2.0] - 2026-10-20', '## [Unreleased]') })
    expect(problem).toMatch(/no section for 0\.2\.0/)
  })

  it('wants the section to say something', () => {
    const empty = '## [0.2.0] - 2026-10-20\n\n## [0.1.0] - 2026-10-07\n\nfirst'
    expect(releaseProblems({ ...ready, changelog: empty })).toEqual([expect.stringMatching(/section of CHANGELOG\.md is empty/)])
  })

  it('wants the date of the release on the heading, unless this is a dry run', () => {
    const undated = CHANGELOG.replace('## [0.2.0] - 2026-10-20', '## [0.2.0] - Unreleased')
    const [problem] = releaseProblems({ ...ready, changelog: undated })
    expect(problem).toMatch(/says "Unreleased" where the release date goes/)
    expect(releaseProblems({ ...ready, changelog: undated, allowUndated: true })).toEqual([])
    expect(releaseProblems({ ...ready, changelog: CHANGELOG.replace('2026-10-20', '2026-02-30') })).toHaveLength(1)
    expect(releaseProblems({ ...ready, changelog: CHANGELOG.replace('## [0.2.0] - 2026-10-20', '## [0.2.0]') })[0]).toMatch(/says "no date"/)
  })

  it('does not let the notes carry the marker, which the workflow adds', () => {
    const [problem] = releaseProblems({ ...ready, changelog: CHANGELOG.replace('A short summary.', `A short summary.\n\n${NOTES_END}`) })
    expect(problem).toMatch(/contains "<!-- end of notes -->"/)
  })

  it('reports every problem at once', () => {
    const problems = releaseProblems({ ...ready, packageVersion: '0.1.0', lockVersions: [['version', '0.1.0']], changelog: '' })
    expect(problems).toHaveLength(3)
  })
})

describe('releaseBody', () => {
  const installer = { name: 'Cubex-Setup-0.2.0.exe', size: 89_484_330, sha256: 'b09a7f88c278b3ad4b4628f055127b05698766b4fe3762820f2cb7bd220582bb' }

  it('puts the notes first, then the marker the app stops at, then the download', () => {
    const body = releaseBody({ notes: 'Summary.\n\n- One thing.\n', installer })
    const lines = body.split('\n')
    expect(lines[0]).toBe('Summary.')
    expect(body.indexOf('- One thing.')).toBeLessThan(body.indexOf(NOTES_END))
    expect(body.indexOf(NOTES_END)).toBeLessThan(body.indexOf('## Download'))
    expect(body).toContain('| `Cubex-Setup-0.2.0.exe` | Windows 10 and 11, x64 | 85 MB |')
    expect(body).toContain(`SHA-256: \`${installer.sha256}\``)
    expect(body).toContain('`Get-FileHash .\\Cubex-Setup-0.2.0.exe`')
    expect(body.endsWith('\n')).toBe(true)
  })

  it('is only the notes and the marker when there is no installer yet', () => {
    expect(releaseBody({ notes: 'Only notes.' })).toBe(`Only notes.\n\n${NOTES_END}\n`)
  })
})

describe('recordedDigest', () => {
  const sha = 'b09a7f88c278b3ad4b4628f055127b05698766b4fe3762820f2cb7bd220582bb'
  const draft = (overrides = {}) => ({
    tag_name: 'v0.2.0',
    draft: true,
    assets: [{ name: 'Cubex-Setup-0.2.0.exe', digest: `sha256:${sha}` }],
    ...overrides
  })

  it('reads the checksum GitHub recorded for the file of the draft', () => {
    expect(recordedDigest([draft()], 'v0.2.0', 'Cubex-Setup-0.2.0.exe')).toBe(`sha256:${sha}`)
  })

  it('finds the draft among the releases that are already published', () => {
    const older = { tag_name: 'v0.1.0', draft: false, assets: [{ name: 'Cubex-Setup-0.1.0.exe', digest: `sha256:${'c'.repeat(64)}` }] }
    expect(recordedDigest([draft(), older], 'v0.2.0', 'Cubex-Setup-0.2.0.exe')).toBe(`sha256:${sha}`)
    expect(recordedDigest([draft(), older], 'v0.1.0', 'Cubex-Setup-0.1.0.exe')).toBeUndefined()
  })

  it('has nothing until GitHub has recorded one', () => {
    expect(recordedDigest([draft({ assets: [{ name: 'Cubex-Setup-0.2.0.exe', digest: null }] })], 'v0.2.0', 'Cubex-Setup-0.2.0.exe')).toBeUndefined()
    expect(recordedDigest([draft({ assets: [{ name: 'Cubex-Setup-0.2.0.exe' }] })], 'v0.2.0', 'Cubex-Setup-0.2.0.exe')).toBeUndefined()
    expect(recordedDigest([draft({ assets: [] })], 'v0.2.0', 'Cubex-Setup-0.2.0.exe')).toBeUndefined()
  })

  it('has nothing for a file, a tag or a list it does not know', () => {
    expect(recordedDigest([draft()], 'v0.2.0', 'Other.exe')).toBeUndefined()
    expect(recordedDigest([draft()], 'v0.3.0', 'Cubex-Setup-0.2.0.exe')).toBeUndefined()
    expect(recordedDigest([], 'v0.2.0', 'Cubex-Setup-0.2.0.exe')).toBeUndefined()
    expect(recordedDigest({ message: 'Not Found' }, 'v0.2.0', 'Cubex-Setup-0.2.0.exe')).toBeUndefined()
    expect(recordedDigest([null, 5, 'x', { tag_name: 'v0.2.0', draft: true, assets: 'no' }], 'v0.2.0', 'Cubex-Setup-0.2.0.exe')).toBeUndefined()
  })

  it('does not take a release that is already published for the draft', () => {
    expect(recordedDigest([draft({ draft: false })], 'v0.2.0', 'Cubex-Setup-0.2.0.exe')).toBeUndefined()
  })

  it.each(['sha1:abc', `sha256:${'g'.repeat(64)}`, `sha256:${sha.slice(1)}`, `SHA256:${sha}`, sha])('does not take %j for a checksum', (digest) => {
    expect(recordedDigest([draft({ assets: [{ name: 'Cubex-Setup-0.2.0.exe', digest }] })], 'v0.2.0', 'Cubex-Setup-0.2.0.exe')).toBeUndefined()
  })
})

describe('the app and the release agree', () => {
  it('uses the same line to end the notes', () => {
    expect(NOTES_END).toBe(UPDATE_NOTES_END)
  })

  it('shows the app the notes, not the download table', () => {
    const notes = findSection(CHANGELOG, '0.2.0')?.body ?? ''
    const body = releaseBody({ notes, installer: { name: 'Cubex-Setup-0.2.0.exe', size: 89_484_330, sha256: 'a'.repeat(64) } })
    const parsed = parseRelease({
      tag_name: 'v0.2.0',
      name: 'Cubex 0.2.0',
      body,
      draft: false,
      prerelease: false,
      html_url: 'https://github.com/HeshamXOR/Cubex/releases/tag/v0.2.0',
      assets: [{
        name: 'Cubex-Setup-0.2.0.exe',
        size: 89_484_330,
        state: 'uploaded',
        digest: `sha256:${'a'.repeat(64)}`,
        browser_download_url: 'https://github.com/HeshamXOR/Cubex/releases/download/v0.2.0/Cubex-Setup-0.2.0.exe'
      }]
    }, GITHUB_FEED)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.release.info.notes).toBe(notes)
    expect(parsed.release.info.notes).not.toContain('Download')
    expect(parsed.release.info.notes).not.toContain('SHA-256')
    expect(parsed.release.installer?.sha256).toBe('a'.repeat(64))
  })

  it('builds the installer under the name the updater looks for', () => {
    const builder = readFileSync(join(root, 'electron-builder.yml'), 'utf8')
    const template = /^nsis:[\s\S]*?^\s+artifactName:\s*(\S+)/m.exec(builder)?.[1]
    expect(template).toBe('Cubex-Setup-${version}.${ext}')
    const name = (template ?? '').replace('${version}', '0.2.0').replace('${ext}', 'exe')
    const parsed = parseRelease({
      tag_name: 'v0.2.0',
      html_url: 'https://github.com/HeshamXOR/Cubex/releases/tag/v0.2.0',
      assets: [{ name, size: 1_000, state: 'uploaded', digest: `sha256:${'b'.repeat(64)}`, browser_download_url: `https://github.com/HeshamXOR/Cubex/releases/download/v0.2.0/${name}` }]
    }, GITHUB_FEED)
    expect(parsed.ok && parsed.release.installer?.name).toBe('Cubex-Setup-0.2.0.exe')
  })
})

describe('the changelog of this repository', () => {
  const headings = changelogFile.split('\n').filter((line) => line.startsWith('## '))
  const versionOf = (heading) => /(\d+)\.(\d+)\.(\d+)/.exec(heading)?.slice(1).map(Number) ?? []

  it('has headings the release check can read, and only the newest one may be unreleased', () => {
    expect(headings.length).toBeGreaterThanOrEqual(2)
    headings.forEach((heading, index) => {
      const section = findSection(`${heading}\n\ntext`, versionOf(heading).join('.'))
      expect(section, heading).toBeDefined()
      if (index === 0 && section?.date === 'Unreleased') return
      expect(isDate(section?.date ?? ''), `${heading} needs a date`).toBe(true)
    })
  })

  it('lists versions newest first', () => {
    const versions = headings.map(versionOf)
    for (let index = 1; index < versions.length; index++) {
      const [a, b] = [versions[index - 1] ?? [], versions[index] ?? []]
      const newer = a[0] !== b[0] ? (a[0] ?? 0) > (b[0] ?? 0) : a[1] !== b[1] ? (a[1] ?? 0) > (b[1] ?? 0) : (a[2] ?? 0) > (b[2] ?? 0)
      expect(newer, `${headings[index - 1]} should come after ${headings[index]}`).toBe(true)
    }
  })

  it('has a section for the version in package.json, with something in it', () => {
    const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
    const section = findSection(changelogFile, version)
    expect(section, `a section for ${version}`).toBeDefined()
    expect(section?.body.length).toBeGreaterThan(100)
  })

  it('keeps the version that was released', () => {
    expect(findSection(changelogFile, '0.1.0')?.date).toBe('2026-10-07')
    expect(findSection(changelogFile, '0.1.0')?.body).toContain('17 provider presets')
  })

  it('never writes the marker itself', () => {
    expect(changelogFile).not.toContain(NOTES_END)
  })
})

describe('the command line', () => {
  const directory = mkdtempSync(join(tmpdir(), 'cubex-release-'))
  afterAll(() => rmSync(directory, { recursive: true, force: true }))

  const run = (...args) => {
    try {
      return { code: 0, out: execFileSync(process.execPath, [script, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), err: '' }
    } catch (error) {
      return { code: error.status ?? 1, out: String(error.stdout ?? ''), err: String(error.stderr ?? '') }
    }
  }

  it('prints the version in package.json', () => {
    const result = run('version')
    expect(result.code).toBe(0)
    expect(result.out.trim()).toBe(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version)
  })

  it('refuses a tag the repository is not ready for, and says why', () => {
    const result = run('check', 'v9.9.9')
    expect(result.code).toBe(1)
    expect(result.err).toMatch(/package\.json says version \d+\.\d+\.\d+, and the tag is for 9\.9\.9/)
    expect(result.err).toMatch(/no section for 9\.9\.9/)
  })

  it('refuses something that is not a tag', () => {
    const result = run('check', 'main')
    expect(result.code).toBe(1)
    expect(result.err).toMatch(/not a release tag/)
  })

  it('explains itself when it is called wrongly', () => {
    const result = run('publish')
    expect(result.code).toBe(2)
    expect(result.err).toMatch(/Usage:/)
  })

  it('prints the notes of a version and the download table of an installer, with its real checksum', () => {
    const file = join(directory, 'Cubex-Setup-0.1.0.exe')
    const bytes = Buffer.alloc(3 * 1024 * 1024 + 17, 7)
    writeFileSync(file, bytes)
    const result = run('notes', '0.1.0', '--installer', file)
    expect(result.code).toBe(0)
    expect(result.out).toContain('The first public release of Cubex')
    expect(result.out).toContain(NOTES_END)
    expect(result.out).toContain('| `Cubex-Setup-0.1.0.exe` | Windows 10 and 11, x64 | 3 MB |')
    expect(result.out).toContain(`SHA-256: \`${createHash('sha256').update(bytes).digest('hex')}\``)
  })

  it('describes an installer by name, size and checksum', async () => {
    const file = join(directory, 'Cubex-Setup-0.1.0.exe')
    const info = await describeInstaller(file)
    expect(info).toMatchObject({ name: 'Cubex-Setup-0.1.0.exe', size: 3 * 1024 * 1024 + 17 })
    expect(info.sha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('has no notes to print for a version the changelog does not have', () => {
    const result = run('notes', '9.9.9')
    expect(result.code).toBe(1)
    expect(result.err).toMatch(/no notes for 9\.9\.9/)
  })

  const runWithInput = (input, ...args) => {
    try {
      return { code: 0, out: execFileSync(process.execPath, [script, ...args], { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] }), err: '' }
    } catch (error) {
      return { code: error.status ?? 1, out: String(error.stdout ?? ''), err: String(error.stderr ?? '') }
    }
  }
  const listed = JSON.stringify([{ tag_name: 'v0.2.0', draft: true, assets: [{ name: 'Cubex-Setup-0.2.0.exe', digest: `sha256:${'d'.repeat(64)}` }] }])

  it('reads a checksum out of the list of releases that GitHub answers with', () => {
    const result = runWithInput(listed, 'digest', 'v0.2.0', 'Cubex-Setup-0.2.0.exe')
    expect(result.code).toBe(0)
    expect(result.out.trim()).toBe(`sha256:${'d'.repeat(64)}`)
  })

  it('prints nothing, and does not fail, while GitHub has no checksum yet', () => {
    const result = runWithInput(listed, 'digest', 'v0.2.0', 'Another.exe')
    expect(result.code).toBe(0)
    expect(result.out).toBe('')
  })

  it('fails on an answer that is not a list of releases, so the workflow tries again', () => {
    const result = runWithInput('<html>Bad gateway</html>', 'digest', 'v0.2.0', 'Cubex-Setup-0.2.0.exe')
    expect(result.code).toBe(1)
    expect(result.err).toMatch(/could not be read/)
    expect(runWithInput('', 'digest', 'v0.2.0', 'Cubex-Setup-0.2.0.exe').code).toBe(1)
  })
})
