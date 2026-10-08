import {
  Bell,
  Cpu,
  Download,
  Gauge,
  HardDrive,
  Info,
  Lock,
  MessagesSquare,
  Palette,
  ShieldCheck,
  SlidersHorizontal,
  Wrench,
  type LucideIcon
} from 'lucide-react'

/**
 * The pages of Settings. Each page is one place in the navigation and shows only its own groups. A group belongs to a
 * page through the `page` it declares (see ./registry), so adding a feature's settings never means editing this list
 * unless the feature needs a page of its own.
 */
export type SettingsPageId =
  | 'general'
  | 'appearance'
  | 'notifications'
  | 'models'
  | 'context'
  | 'local'
  | 'tools'
  | 'permissions'
  | 'agents'
  | 'privacy'
  | 'updates'
  | 'about'

export interface SettingsPage {
  id: SettingsPageId
  /** The name in the navigation and the title of the page. */
  label: string
  /** One sentence under the title: what is on this page. */
  description: string
  /** Words a person might search for (Ctrl+K) that the label does not contain. */
  keywords: string
  icon: LucideIcon
}

export interface SettingsNavSection {
  /** A quiet label above these pages. The first section has none. */
  heading?: string
  pages: SettingsPage[]
}

export const SETTINGS_NAV: SettingsNavSection[] = [
  {
    pages: [
      { id: 'general', label: 'General', description: 'Startup, and the folder Cubex works in.', keywords: 'start maximized window working folder workspace project', icon: SlidersHorizontal },
      { id: 'appearance', label: 'Appearance', description: 'Theme, accent color, font, density and the shape of corners.', keywords: 'theme dark light system accent color font density corners', icon: Palette },
      { id: 'notifications', label: 'Notifications', description: 'When Cubex tells you that a session needs you or has ended.', keywords: 'alerts badge taskbar flash', icon: Bell }
    ]
  },
  {
    heading: 'Models',
    pages: [
      { id: 'models', label: 'Models', description: 'How long a reply can be, how failures are retried and how long Cubex waits for a provider.', keywords: 'max output tokens reply length retry attempts timeout rate limit', icon: Cpu },
      { id: 'context', label: 'Context and cost', description: 'How long sessions stay inside the context window, and the spending limits that stop a turn.', keywords: 'summarize summarizing compaction budget spending limit cost tokens', icon: Gauge },
      { id: 'local', label: 'Local models', description: 'Where Cubex finds Ollama and how much a local model can hold at once.', keywords: 'ollama local ai context size', icon: HardDrive }
    ]
  },
  {
    heading: 'Agent',
    pages: [
      { id: 'tools', label: 'Tools', description: 'The shell, type checking, skills, MCP servers and hooks the agent can use.', keywords: 'shell terminal command type checking diagnostics skills mcp hooks', icon: Wrench },
      { id: 'permissions', label: 'Permissions', description: 'Which actions Cubex allows, asks about or blocks.', keywords: 'allow ask deny block rules approvals', icon: ShieldCheck },
      { id: 'agents', label: 'Other agents', description: 'Let the agent consult Claude Code, Antigravity or another model and settle a question together.', keywords: 'claude code agy antigravity consult second opinion peer cli agree', icon: MessagesSquare }
    ]
  },
  {
    heading: 'Application',
    pages: [
      { id: 'privacy', label: 'Privacy', description: 'Local-only mode and the logs kept on this PC.', keywords: 'local only logging logs keychain', icon: Lock },
      { id: 'updates', label: 'Updates', description: 'Check for new versions and read what changed.', keywords: 'update version release check new automatic', icon: Download },
      { id: 'about', label: 'About', description: 'The version, the licenses and where your data lives.', keywords: 'version licenses data folder', icon: Info }
    ]
  }
]

export const SETTINGS_PAGES: SettingsPage[] = SETTINGS_NAV.flatMap((section) => section.pages)

export const DEFAULT_SETTINGS_PAGE: SettingsPageId = 'general'

export function settingsPage(id: string | undefined): SettingsPage | undefined {
  return SETTINGS_PAGES.find((page) => page.id === id)
}
