#!/usr/bin/env node
// Release helpers, used by .github/workflows/release.yml and by hand before a tag is pushed (docs/RELEASING.md).
//
//   node scripts/release.mjs version
//       Prints the version in package.json.
//   node scripts/release.mjs check <tag> [--allow-undated]
//       Says what stands in the way of publishing this tag, or that nothing does. Exits 1 when something does.
//   node scripts/release.mjs notes <version> [--installer <file>]
//       Prints the body of the GitHub release: this version's notes from CHANGELOG.md, the line the app stops reading
//       at, and, with --installer, the download table and the file's SHA-256.
//   node scripts/release.mjs digest <tag> <file name>   (reads GitHub's list of releases from standard input)
//       Prints the checksum GitHub recorded for that file of that draft release, or nothing if there is none yet.
//
// Nothing here uses the network or writes a file.

import { createHash } from 'node:crypto'
import { createReadStream, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** The line the app stops reading release notes at. It is UPDATE_NOTES_END in src/shared/updates.ts; release.test.mjs checks they agree. */
export const NOTES_END = '<!-- end of notes -->'

const TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const HEADING = /^##[ \t]+\[?v?(\d+\.\d+\.\d+)\]?(?:[ \t]+-[ \t]+(.*?))?[ \t]*$/

/** "v0.2.0" gives "0.2.0". Anything that is not a version tag gives undefined. */
export function versionOfTag(tag) {
  return TAG.test(tag) ? tag.slice(1) : undefined
}

/** A calendar date written YYYY-MM-DD. */
export function isDate(text) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text)
  if (!match) return false
  const [year, month, day] = match.slice(1).map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

/**
 * What the changelog says about one version: its heading, the date on the heading, and the text under it up to the next
 * "##" heading. A heading is "## [0.2.0] - 2026-10-20" or "## 0.2.0". Undefined when the version has no section.
 */
export function findSection(changelog, version) {
  const lines = changelog.replace(/\r\n?/g, '\n').split('\n')
  const start = lines.findIndex((line) => HEADING.exec(line)?.[1] === version)
  if (start < 0) return undefined
  let end = lines.length
  for (let index = start + 1; index < lines.length; index++) {
    if (/^##[ \t]/.test(lines[index])) { end = index; break }
  }
  const date = HEADING.exec(lines[start])?.[2]?.trim() ?? ''
  return { heading: lines[start], date, body: lines.slice(start + 1, end).join('\n').trim() }
}

/**
 * Everything that would make a release wrong, each as a sentence that says what to change. Empty when the tag is ready.
 * `lockVersions` is a list of [where, version] pairs read from package-lock.json.
 */
export function releaseProblems({ tag, packageVersion, lockVersions = [], changelog, allowUndated = false }) {
  const version = versionOfTag(tag)
  if (!version) return [`"${tag}" is not a release tag. A release tag is a v and three numbers, such as v0.2.0.`]
  const problems = []
  if (packageVersion !== version) {
    problems.push(`package.json says version ${packageVersion}, and the tag is for ${version}. Run "npm version ${version} --no-git-tag-version", commit it, and tag that commit.`)
  }
  for (const [where, found] of lockVersions) {
    if (found !== version) problems.push(`package-lock.json (${where}) says ${found}, not ${version}. Run "npm version ${version} --no-git-tag-version" to bring it in line.`)
  }
  const section = findSection(changelog, version)
  if (!section) {
    problems.push(`CHANGELOG.md has no section for ${version}. Add "## [${version}] - YYYY-MM-DD" and write what changed under it. The app shows that text to the people who update.`)
    return problems
  }
  if (!section.body) problems.push(`The ${version} section of CHANGELOG.md is empty. Write what changed: it is what the app shows to the people who update.`)
  if (section.body.includes(NOTES_END)) problems.push(`The ${version} section of CHANGELOG.md contains "${NOTES_END}". The release workflow adds that line; remove it.`)
  if (!allowUndated && !isDate(section.date)) {
    problems.push(`The heading of ${version} in CHANGELOG.md says "${section.date || 'no date'}" where the release date goes. Write it as "## [${version}] - YYYY-MM-DD".`)
  }
  return problems
}

const megabytes = (bytes) => `${Math.round(bytes / (1024 * 1024))} MB`

/**
 * The body of the GitHub release. The people already running Cubex see everything above the marker in the update
 * window; the release page also shows the download table under it, for someone who does not have the app yet.
 */
export function releaseBody({ notes, installer }) {
  const parts = [notes.trim(), '', NOTES_END]
  if (installer) {
    parts.push(
      '',
      '## Download',
      '',
      '| File | Platform | Size |',
      '|---|---|---|',
      `| \`${installer.name}\` | Windows 10 and 11, x64 | ${megabytes(installer.size)} |`,
      '',
      `SHA-256: \`${installer.sha256}\``,
      '',
      `The installer is not code-signed yet, so Windows SmartScreen may show "Windows protected your PC". Select **More info**, then **Run anyway**. To confirm that the file is the one published here, compare \`Get-FileHash .\\${installer.name}\` in PowerShell with the checksum above.`
    )
  }
  return `${parts.join('\n')}\n`
}

/**
 * The checksum GitHub recorded for one file of the draft release with this tag, out of GitHub's list of releases.
 * Undefined when there is no such draft or file, or the file has no checksum yet.
 */
export function recordedDigest(releases, tag, assetName) {
  if (!Array.isArray(releases)) return undefined
  const release = releases.find((entry) => entry?.tag_name === tag && entry?.draft === true)
  const asset = Array.isArray(release?.assets) ? release.assets.find((entry) => entry?.name === assetName) : undefined
  return typeof asset?.digest === 'string' && /^sha256:[0-9a-f]{64}$/.test(asset.digest) ? asset.digest : undefined
}

/** The file's name, size and lowercase SHA-256. */
export async function describeInstaller(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return { name: path.split(/[\\/]/).pop(), size: statSync(path).size, sha256: hash.digest('hex') }
}

const read = (path) => readFileSync(path, 'utf8')

function option(args, name) {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

async function main(argv) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const [command, subject, ...rest] = argv
  const annotate = process.env.GITHUB_ACTIONS === 'true'
  const fail = (text) => {
    console.error(annotate ? `::error::${text}` : text)
    process.exitCode = 1
  }

  if (command === 'version') {
    console.log(JSON.parse(read(join(root, 'package.json'))).version)
    return
  }

  if (command === 'check' && subject) {
    const packageJson = JSON.parse(read(join(root, 'package.json')))
    const lock = JSON.parse(read(join(root, 'package-lock.json')))
    const problems = releaseProblems({
      tag: subject,
      packageVersion: packageJson.version,
      lockVersions: [['version', lock.version], ['packages[""]', lock.packages?.['']?.version]],
      changelog: read(join(root, 'CHANGELOG.md')),
      allowUndated: rest.includes('--allow-undated')
    })
    if (problems.length > 0) {
      for (const problem of problems) fail(problem)
      return
    }
    console.log(`${subject} is ready: package.json, package-lock.json and CHANGELOG.md agree on ${versionOfTag(subject)}.`)
    return
  }

  if (command === 'digest' && subject && rest[0]) {
    let releases
    try { releases = JSON.parse(readFileSync(0, 'utf8')) } catch { return fail('The list of releases could not be read.') }
    const digest = recordedDigest(releases, subject, rest[0])
    if (digest) console.log(digest)
    return
  }

  if (command === 'notes' && subject) {
    const section = findSection(read(join(root, 'CHANGELOG.md')), subject)
    if (!section || !section.body) return fail(`CHANGELOG.md has no notes for ${subject}.`)
    const file = option(rest, '--installer')
    process.stdout.write(releaseBody({ notes: section.body, installer: file ? await describeInstaller(file) : undefined }))
    return
  }

  console.error([
    'Usage:',
    '  node scripts/release.mjs version',
    '  node scripts/release.mjs check <tag> [--allow-undated]',
    '  node scripts/release.mjs notes <version> [--installer <file>]',
    '  node scripts/release.mjs digest <tag> <file name>'
  ].join('\n'))
  process.exitCode = 2
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
