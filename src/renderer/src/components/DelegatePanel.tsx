import { Check, Minus, X } from 'lucide-react'
import type { ToolActivity } from '../../../shared/ipc'
import type { DelegateActivity } from '../../../shared/peers'
import { FILE_CHANGE_WORD, reportHeading, STEP_SPOKEN, stepView, untrackedNote } from '../lib/delegateText'
import { ActivityGlyph } from '../theme/StateIcons'
import { Markdown } from './Markdown'
import { PathLink } from './PathLink'

/**
 * What a task handed to another agent shows when its row is opened: the task as it was sent, each step the agent took,
 * the files it changed and its own report. It fills in while the task runs.
 */
export function DelegatePanel({ id, tool, activity }: { id: string; tool: ToolActivity; activity: DelegateActivity }): JSX.Element {
  const note = untrackedNote(activity.files)
  return (
    <div id={id} className="toolrow__task" role="region" aria-label={`Task for ${activity.name}`} tabIndex={0}>
      {activity.asked && (
        <>
          <div className="toolrow__label">Task</div>
          <div className="toolrow__quote">{activity.asked}</div>
        </>
      )}
      {activity.steps.length > 0 && (
        <>
          <div className="toolrow__label">Steps</div>
          <ul className="dsteps" tabIndex={0} aria-label="Steps the agent took">
            {activity.steps.map((step, index) => {
              const view = stepView(activity, step)
              return (
                <li key={index} className="dstep" data-state={view}>
                  <span className="dstep__mark" aria-hidden="true">
                    {view === 'done' ? <Check size={12} strokeWidth={2} />
                      : view === 'failed' ? <X size={12} strokeWidth={2} />
                        : view === 'stopped' ? <Minus size={12} strokeWidth={2} />
                          : <ActivityGlyph kind="thinking" size={12} active />}
                  </span>
                  <span className="dstep__title">{step.title}</span>
                  <span className="sr-only">{STEP_SPOKEN[view]}</span>
                </li>
              )
            })}
          </ul>
        </>
      )}
      {activity.files.length > 0 && (
        <>
          <div className="toolrow__label">Files changed</div>
          <ul className="dfiles">
            {activity.files.map((file) => (
              <li key={file.path} className="dfile">
                <span className="dfile__path">{file.change === 'deleted' ? file.path : <PathLink text={file.path} className="pathlink--clip">{file.path}</PathLink>}</span>
                <span className="dfile__change">{FILE_CHANGE_WORD[file.change]}</span>
                {!file.tracked && <span className="dfile__flag" title="Changed without Cubex being asked, so no copy was saved">not kept</span>}
              </li>
            ))}
          </ul>
          {note && <p className="dfiles__note">{note}</p>}
        </>
      )}
      {tool.detail && (
        <>
          <div className="toolrow__label">{reportHeading(activity)}</div>
          <div className="prose"><Markdown text={tool.detail} /></div>
        </>
      )}
    </div>
  )
}
