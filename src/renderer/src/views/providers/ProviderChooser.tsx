import { Plus, X } from 'lucide-react'
import { PRESET_GROUPS, PROVIDER_PRESETS, type ProviderPreset } from '../../../../shared/providerPresets'

/**
 * The providers Cubex can set up from a preset, grouped by where they run. A choice fills in the address,
 * default model and the way the key is sent, so the person only has to paste a key. Each button is named by
 * its own text: the preset name followed by the one line about what it needs.
 */
export function ProviderChooser({ onChoose, onClose }: { onChoose: (preset: ProviderPreset) => void; onClose?: () => void }): JSX.Element {
  return (
    <section
      className="providers__chooser"
      aria-labelledby="providers-add-title"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && onClose) {
          event.stopPropagation()
          onClose()
        }
      }}
    >
      <div className="providers__panel-head">
        <div>
          <h2 className="providers__panel-title" id="providers-add-title">Add a provider</h2>
          <p className="providers__panel-sub">Choose one to fill in its address and default model. You paste the key next.</p>
        </div>
        {onClose && (
          <button type="button" className="providers__close" onClick={onClose} aria-label="Close the list of providers">
            <X size={15} aria-hidden="true" />
          </button>
        )}
      </div>
      {PRESET_GROUPS.map((group) => (
        <div key={group.id} className="providers__group">
          <h3 className="providers__group-title">{group.label}</h3>
          <ul className="providers__choices">
            {PROVIDER_PRESETS.filter((preset) => preset.group === group.id).map((preset) => (
              <li key={preset.id}>
                <button type="button" className="providers__choice" onClick={() => onChoose(preset)}>
                  <span className="providers__choice-text">
                    <span className="providers__choice-name">{preset.label}</span>{' '}
                    <span className="providers__choice-needs">{preset.needs}</span>
                  </span>
                  <Plus size={14} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  )
}
