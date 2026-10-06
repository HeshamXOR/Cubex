import { realpathSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import type * as TS from 'typescript'
import type { TypeScriptApi } from './tsHost'
import type { CheckOutcome } from './tsProtocol'
import type { Diagnostic } from './types'
import { ancestorNodeModules, isWithinRoot, pathKey, relativeToRoot, sourceKind, tsPath } from './paths'
import { findProjectConfig } from './projectConfig'
import { GuardedFs } from './tsFs'

export interface CheckerOptions {
  ts: TypeScriptApi
  root: string
  /** Polled while a check runs, including inside the compiler; return true to stop it as soon as possible. */
  cancelled?: () => boolean
  /** A project with more files than this is not checked: building its program would stall the machine. */
  maxProgramFiles?: number
}

/** A parsed tsconfig.json or jsconfig.json. Re-parsed when the file on disk changes. */
interface ConfigInfo {
  configFile: string
  stamp: string
  parsed: TS.ParsedCommandLine
  /** pathKey of every file the config names, for an exact membership test. */
  included: Set<string>
}

interface Project {
  info: ConfigInfo
  service: TS.LanguageService
  /** Text a check evaluates in place of the file on disk. Present only while that check runs. */
  overrides: Map<string, { version: number; text: string }>
  edits: number
}

type ProjectLookup = { project: Project } | { skipped: string }

const NO_CONFIG = 'No tsconfig.json or jsconfig.json'

export class ProjectChecker {
  private readonly ts: TypeScriptApi
  private readonly root: string
  private readonly cancelled: () => boolean
  private readonly maxProgramFiles: number
  private readonly fs: GuardedFs
  private readonly configs = new Map<string, ConfigInfo>()
  private readonly projects = new Map<string, Project>()

  constructor(options: CheckerOptions) {
    this.ts = options.ts
    this.root = options.root
    this.cancelled = options.cancelled ?? (() => false)
    this.maxProgramFiles = options.maxProgramFiles ?? 3000

    let realRoot = this.root
    try { realRoot = realpathSync.native(this.root) } catch { /* a root that cannot be resolved is used as spelled */ }

    const libDir = dirname(this.ts.getDefaultLibFilePath({}))
    let realLib = libDir
    try { realLib = realpathSync.native(libDir) } catch { /* the lib folder is used as spelled */ }

    this.fs = new GuardedFs([
      this.root,
      realRoot,
      ...ancestorNodeModules(this.root),
      ...ancestorNodeModules(realRoot),
      libDir,
      realLib
    ])
  }

  /** The file's diagnostics with its previous text (when there is one) and with its new text, in this project. */
  check(abs: string, before: string | null, after: string): CheckOutcome {
    const ready = this.prepare(abs)
    if (!('project' in ready)) return ready
    const { project } = ready
    try {
      let beforeDiagnostics: Diagnostic[] | undefined
      if (before !== null) {
        beforeDiagnostics = this.diagnosticsOf(project, abs, before)
        if (this.cancelled()) return { status: 'cancelled' }
      }
      const afterDiagnostics = this.diagnosticsOf(project, abs, after)
      if (this.cancelled()) return { status: 'cancelled' }
      return { status: 'ok', ...(beforeDiagnostics !== undefined ? { before: beforeDiagnostics } : {}), after: afterDiagnostics }
    } catch (error) {
      return this.failure(error)
    } finally {
      project.overrides.delete(tsPath(abs))
    }
  }

  /** The file's diagnostics as it is on disk now. Unchanged files answer from the compiler's cache. */
  current(abs: string): CheckOutcome {
    const ready = this.prepare(abs)
    if (!('project' in ready)) return ready
    if (!this.fs.isReadable(abs)) return { status: 'skipped', reason: 'File does not exist or cannot be read.' }
    try {
      const after = this.diagnosticsOf(ready.project, abs)
      return this.cancelled() ? { status: 'cancelled' } : { status: 'ok', after }
    } catch (error) {
      return this.failure(error)
    }
  }

  /**
   * Build the program of the workspace's project ahead of the first edit, so that check does not pay for
   * parsing every file. A solution-style config (only references) warms the projects it points to.
   */
  warm(): CheckOutcome {
    if (this.cancelled()) return { status: 'cancelled' }
    const configFile = findProjectConfig(this.root)
    if (!configFile) return { status: 'skipped', reason: NO_CONFIG }
    try {
      const own = this.projectFor(configFile)
      if ('skipped' in own) return { status: 'skipped', reason: own.skipped }
      const targets = own.project.info.parsed.fileNames.length > 0 ? [own.project] : this.referencedConfigs(configFile).flatMap((path) => {
        const found = this.projectFor(path)
        return 'project' in found ? [found.project] : []
      })
      for (const project of targets.slice(0, 3)) {
        project.service.getProgram()?.getTypeChecker()
        if (this.cancelled()) return { status: 'cancelled' }
      }
      return { status: 'ok' }
    } catch (error) {
      return this.failure(error)
    }
  }

  dispose(): void {
    for (const project of this.projects.values()) {
      try {
        project.service.dispose()
      } catch { /* a service that is already gone needs nothing more */ }
    }
    this.projects.clear()
    this.configs.clear()
  }

  private failure(error: unknown): CheckOutcome {
    if (this.cancelled()) return { status: 'cancelled' }
    return { status: 'failed', reason: error instanceof Error ? error.message : String(error) }
  }

  /** Find the project that owns the file, or say why none does. */
  private prepare(abs: string): { project: Project } | CheckOutcome {
    if (this.cancelled()) return { status: 'cancelled' }
    if (!isWithinRoot(this.root, abs)) return { status: 'skipped', reason: 'File lies outside the workspace.' }
    if (!sourceKind(abs)) return { status: 'skipped', reason: 'Not a supported TypeScript or JavaScript file.' }

    const configFile = this.findConfigFile(abs)
    if (!configFile) return { status: 'skipped', reason: NO_CONFIG }

    const found = this.projectFor(configFile)
    if ('skipped' in found) return { status: 'skipped', reason: found.skipped }
    if (!this.isFileIncluded(found.project, abs)) {
      return { status: 'skipped', reason: `File is not included in "${relativeToRoot(this.root, configFile)}".` }
    }
    if (this.cancelled()) return { status: 'cancelled' }
    return { project: found.project }
  }

  private findConfigFile(abs: string): string | undefined {
    let currentDir = dirname(abs)
    while (isWithinRoot(this.root, currentDir)) {
      for (const name of ['tsconfig.json', 'jsconfig.json']) {
        const candidate = join(currentDir, name)
        if (this.fs.fileExists(candidate)) {
          // A solution-style root only references the projects that hold the files.
          return this.resolveSolutionConfig(candidate, abs) ?? candidate
        }
      }
      const parent = dirname(currentDir)
      if (parent === currentDir) break
      currentDir = parent
    }
    return undefined
  }

  private resolveSolutionConfig(configFile: string, abs: string): string | undefined {
    const key = pathKey(abs)
    for (const refPath of this.referencedConfigs(configFile)) {
      const info = this.configInfo(refPath)
      if (info && (info.included.has(key) || this.isMatch(info.parsed, abs, dirname(refPath)))) return refPath
    }
    return undefined
  }

  /** The project configs a config points to with `references`, as files that exist. */
  private referencedConfigs(configFile: string): string[] {
    const content = this.fs.readFile(configFile)
    if (!content) return []
    const references = (this.ts.parseConfigFileTextToJson(configFile, content).config as { references?: unknown } | undefined)?.references
    if (!Array.isArray(references)) return []
    const found: string[] = []
    for (const reference of references as Array<{ path?: unknown } | null>) {
      if (typeof reference?.path !== 'string') continue
      let path = resolve(dirname(configFile), reference.path)
      if (this.fs.directoryExists(path)) path = join(path, 'tsconfig.json')
      if (this.fs.fileExists(path)) found.push(path)
    }
    return found
  }

  private parseConfigHost(): TS.ParseConfigHost {
    return {
      useCaseSensitiveFileNames: process.platform !== 'win32',
      readDirectory: (rootDir, extensions, excludes, includes, depth) => {
        if (!this.fs.allowed(rootDir)) return []
        try {
          return this.ts.sys.readDirectory(rootDir, extensions, excludes, includes, depth)
        } catch {
          return []
        }
      },
      fileExists: (path) => this.fs.fileExists(path),
      readFile: (path) => this.fs.readFile(path)
    }
  }

  /** Whether a path that may not exist yet is covered by the config's include patterns. */
  private isMatch(parsed: TS.ParsedCommandLine, abs: string, configDir: string): boolean {
    const key = pathKey(abs)
    if (parsed.fileNames.some((name) => pathKey(name) === key)) return true

    for (const dir of Object.keys(parsed.wildcardDirectories ?? {})) {
      if (isWithinRoot(dir, abs)) return true
    }

    const include = (parsed.raw as { include?: unknown } | undefined)?.include
    if (Array.isArray(include)) {
      const rel = relative(configDir, abs).replace(/\\/g, '/')
      for (const pattern of include) {
        if (typeof pattern !== 'string') continue
        const prefix = pattern.replace(/^[./]+/, '').replace(/\/\*.*$/, '')
        if (prefix === '' || rel.startsWith(prefix)) return true
      }
    }
    return false
  }

  private isFileIncluded(project: Project, abs: string): boolean {
    if (this.fs.fileExists(abs)) return project.info.included.has(pathKey(abs))
    return this.isMatch(project.info.parsed, abs, dirname(project.info.configFile))
  }

  /** The parsed config, re-read when its file changed since it was parsed. */
  private configInfo(configFile: string): ConfigInfo | undefined {
    const key = pathKey(configFile)
    const stamp = this.fs.version(configFile)
    const cached = this.configs.get(key)
    if (cached && cached.stamp === stamp) return cached

    const content = this.fs.readFile(configFile)
    if (!content) return undefined
    const json = this.ts.parseConfigFileTextToJson(configFile, content)
    if (!json.config) return undefined
    const parsed = this.ts.parseJsonConfigFileContent(json.config, this.parseConfigHost(), dirname(configFile), undefined, configFile)
    const info: ConfigInfo = { configFile, stamp, parsed, included: new Set(parsed.fileNames.map((name) => pathKey(name))) }
    this.configs.set(key, info)
    return info
  }

  private projectFor(configFile: string): ProjectLookup {
    const info = this.configInfo(configFile)
    if (!info) return { skipped: 'Failed to configure project.' }
    if (info.parsed.fileNames.length > this.maxProgramFiles) {
      return { skipped: `The project has ${info.parsed.fileNames.length} files, more than the ${this.maxProgramFiles} that are checked after edits.` }
    }

    const key = pathKey(configFile)
    const existing = this.projects.get(key)
    if (existing && existing.info === info) return { project: existing }
    // The config changed on disk: its old language service describes a project that no longer exists.
    try { existing?.service.dispose() } catch { /* nothing more to release */ }

    const project = this.createProject(info)
    this.projects.set(key, project)
    return { project }
  }

  private createProject(info: ConfigInfo): Project {
    const rootFiles = info.parsed.fileNames.map((name) => tsPath(name))
    const overrides = new Map<string, { version: number; text: string }>()

    // Every file the compiler reads is the one on disk, stamped by modification time and size, so a change made by
    // anything other than Cubex (an editor, git, a shell command) is seen. Only the file under check is replaced.
    const host: TS.LanguageServiceHost = {
      getCompilationSettings: () => ({ ...info.parsed.options, noEmit: true }),
      getScriptFileNames: () => [...new Set([...rootFiles, ...overrides.keys()])],
      getScriptVersion: (fileName) => {
        const override = overrides.get(tsPath(fileName))
        return override ? `edit:${override.version}` : this.fs.version(fileName)
      },
      getScriptSnapshot: (fileName) => {
        const text = overrides.get(tsPath(fileName))?.text ?? this.fs.readFile(fileName)
        return text !== undefined ? this.ts.ScriptSnapshot.fromString(text) : undefined
      },
      getCancellationToken: () => ({ isCancellationRequested: () => this.cancelled() }),
      getCurrentDirectory: () => dirname(info.configFile),
      getDefaultLibFileName: (options) => this.ts.getDefaultLibFilePath(options),
      fileExists: (path) => overrides.has(tsPath(path)) || this.fs.fileExists(path),
      readFile: (path) => overrides.get(tsPath(path))?.text ?? this.fs.readFile(path),
      readDirectory: (rootDir, extensions, excludes, includes, depth) => {
        if (!this.fs.allowed(rootDir)) return []
        try {
          return this.ts.sys.readDirectory(rootDir, extensions, excludes, includes, depth)
        } catch {
          return []
        }
      },
      directoryExists: (path) => this.fs.directoryExists(path),
      getDirectories: (path) => this.fs.getDirectories(path),
      realpath: (path) => this.fs.realpath(path)
    }
    const service = this.ts.createLanguageService(host, this.ts.createDocumentRegistry())
    return { info, service, overrides, edits: 0 }
  }

  /** Syntax and type errors of one file. `text` replaces the file on disk for this call; omit it to use the disk. */
  private diagnosticsOf(project: Project, abs: string, text?: string): Diagnostic[] {
    const name = tsPath(abs)
    if (text !== undefined) project.overrides.set(name, { version: ++project.edits, text })
    const all = [...project.service.getSyntacticDiagnostics(name), ...project.service.getSemanticDiagnostics(name)]
    return all.flatMap((diagnostic) => this.toDiagnostic(diagnostic) ?? [])
  }

  private toDiagnostic(d: TS.Diagnostic): Diagnostic | undefined {
    const category = this.ts.DiagnosticCategory
    if (d.category !== category.Error && d.category !== category.Warning) return undefined

    const file = d.file
    let line = 1
    let col = 1
    let context: string | undefined
    if (file && d.start !== undefined) {
      const position = file.getLineAndCharacterOfPosition(d.start)
      line = position.line + 1
      col = position.character + 1
      const lineStart = file.getPositionOfLineAndCharacter(position.line, 0)
      const lineEnd = file.text.indexOf('\n', lineStart)
      context = file.text.slice(lineStart, lineEnd === -1 ? undefined : lineEnd).replace(/\r$/, '').trim()
    }

    return {
      path: file ? relativeToRoot(this.root, file.fileName) ?? file.fileName : '',
      line,
      col,
      severity: d.category === category.Warning ? 'warning' : 'error',
      code: `TS${d.code}`,
      message: this.ts.flattenDiagnosticMessageText(d.messageText, '\n'),
      ...(context !== undefined ? { context } : {})
    }
  }
}
