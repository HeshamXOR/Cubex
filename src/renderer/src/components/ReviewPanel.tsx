import { ClipboardList, PanelRightClose, ShieldQuestion } from 'lucide-react'
import { useStore } from '../state/store'
import { api } from '../lib/api'
import { useChanges } from '../lib/useSessionChanges'
import { ChangesTab } from './ChangesTab'
import { DetailsPanel } from './DetailsPanel'
import { PlanPanel } from './PlanPanel'
import { extraPanelTabs } from './panelTabs/registry'
import './review.css'

function PlanTab(): JSX.Element {
  const activePlan = useStore((s) => s.activePlan)
  const plans = useStore((s) => s.plans)
  const pendingPlan = useStore((s) => s.pendingPlan)
  const resolvePlan = useStore((s) => s.resolvePlan)
  const openPlan = useStore((s) => s.openPlan)
  const setTab = useStore((s) => s.setPanelTab)
  if (!activePlan) {
    return (
      <div className="rev-empty">
        <ClipboardList size={22} strokeWidth={1.5} aria-hidden="true" />
        <h2>No plan yet</h2>
        <p>In plan mode Cubex researches first and proposes a plan here for you to approve before it changes anything.</p>
      </div>
    )
  }
  return (
    <PlanPanel
      key={activePlan.id}
      plan={activePlan}
      plans={plans}
      pending={pendingPlan?.id === activePlan.id}
      onResolve={(decision, feedback) => resolvePlan(activePlan.id, decision, feedback)}
      onClose={() => setTab('changes')}
      onSelect={openPlan}
      onReveal={() => api.revealPlan(activePlan.id)}
    />
  )
}

/** Where the work is reviewed: the files Cubex changed, the plan it proposed, the model's settings, and any extra tabs (see panelTabs). */
export function ReviewPanel(): JSX.Element {
  const stored = useStore((s) => s.panelTab)
  const setTab = useStore((s) => s.setPanelTab)
  const togglePanel = useStore((s) => s.togglePanel)
  const pendingPlan = useStore((s) => !!s.pendingPlan)
  const { changes } = useChanges()
  const count = changes.files.length

  // Extra tabs decide for themselves whether they have anything to show. The list is fixed, so their hooks run in a stable order.
  const extras = extraPanelTabs.map((def) => ({ def, visible: def.useVisible?.() ?? true, badge: def.useBadge?.() }))
  const tabs: Array<{ id: string; label: string; badge?: number }> = [
    { id: 'changes', label: 'Changes', badge: count > 0 ? count : undefined },
    { id: 'plan', label: 'Plan' },
    { id: 'details', label: 'Details' },
    // A tab that has just gone quiet stays while it is the one being read, so the panel never changes under the reader.
    ...extras.filter((entry) => entry.visible || entry.def.id === stored).map((entry) => ({ id: entry.def.id, label: entry.def.label, badge: entry.badge }))
  ]
  const tab = tabs.some((item) => item.id === stored) ? stored : 'changes'
  const Extra = extras.find((entry) => entry.def.id === tab)?.def.Component

  return (
    <div className="panel review">
      <header className="rev-h">
        <div className="rev-tabs" role="tablist" aria-label="Review sections">
          {tabs.map((item) => (
            <button
              key={item.id}
              role="tab"
              id={`rev-tab-${item.id}`}
              aria-selected={tab === item.id}
              aria-controls="rev-panel"
              tabIndex={tab === item.id ? 0 : -1}
              className={`rev-tab ${tab === item.id ? 'on' : ''}`}
              onClick={() => setTab(item.id as typeof stored)}
              onKeyDown={(event) => {
                const order = tabs.map((entry) => entry.id)
                const move = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
                if (!move) return
                event.preventDefault()
                const next = order[(order.indexOf(tab) + move + order.length) % order.length]!
                setTab(next as typeof stored)
                document.getElementById(`rev-tab-${next}`)?.focus()
              }}
            >
              {item.label}
              {item.badge !== undefined && <span className="rev-count">{item.badge}</span>}
              {item.id === 'plan' && pendingPlan && <ShieldQuestion size={13} className="rev-wait" aria-label="Needs your review" />}
            </button>
          ))}
        </div>
        <span className="grow" />
        <button className="ib" onClick={togglePanel} aria-label="Hide review" title="Hide review"><PanelRightClose size={16} /></button>
      </header>
      <div className="rev-panel" id="rev-panel" role="tabpanel" aria-labelledby={`rev-tab-${tab}`}>
        {tab === 'changes' && <ChangesTab />}
        {tab === 'plan' && <PlanTab />}
        {tab === 'details' && <DetailsPanel />}
        {Extra && <Extra />}
      </div>
    </div>
  )
}
