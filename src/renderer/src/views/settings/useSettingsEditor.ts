import type { AppSettings } from '../../../../shared/settings'
import { useStore } from '../../state/store'

/** What a settings group needs to read and change settings. It is undefined only while settings are still loading. */
export interface SettingsEditor {
  settings: AppSettings
  /** Change some keys of one block of settings and save. */
  patch: <K extends keyof AppSettings>(block: K, value: Partial<AppSettings[K]>) => void
}

export function useSettingsEditor(): SettingsEditor | undefined {
  const settings = useStore((state) => state.settings)
  const save = useStore((state) => state.saveSettings)
  if (!settings) return undefined
  return {
    settings,
    patch: (block, value) => {
      void save({ [block]: { ...settings[block], ...value } } as Partial<AppSettings>)
    }
  }
}
