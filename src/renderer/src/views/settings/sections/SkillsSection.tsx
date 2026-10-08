import { SkillsLibrary } from '../../../components/SkillsLibrary'
import { useStore } from '../../../state/store'
import type { SettingsSection } from '../registry'

function SkillsSettings(): JSX.Element {
  const workspacePath = useStore((state) => state.settings?.general.workspacePath)
  return <SkillsLibrary key={workspacePath ?? ''} workspacePath={workspacePath} />
}

export const section: SettingsSection = { id: 'skills', title: 'Skills', page: 'tools', order: 120, Component: SkillsSettings }
