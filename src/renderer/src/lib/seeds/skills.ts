import type { ChatStartRequest, SkillSummary } from '../../../../shared/ipc'
import { skillLoadFailure } from '../../../../shared/skillInvocation'
import type { PreviewSeed } from './index'

const library = 'C:\\Cubex\\resources\\skills'
const project = 'C:\\Users\\dev\\code\\lumen-web'

const entry = (name: string, source: SkillSummary['source'], description: string): SkillSummary => ({
  name,
  description,
  source,
  path: source === 'bundled' ? `${library}\\${name}\\SKILL.md` : `${project}\\.${source}\\skills\\${name}\\SKILL.md`
})

const sample: SkillSummary[] = [
  entry('migration-checklist', 'cubex', 'Walks through a database migration: lock risk, backfill order, rollback, and the checks to run after the deploy.'),
  entry('release-notes', 'cubex', 'Drafts the changelog entry for a release from the merged pull requests, in the format this repository already uses.'),
  entry('accessibility-audit', 'agents', 'Audits a screen against WCAG 2.2 AA with the checklist the design team keeps next to the components.'),
  entry('export', 'claude', 'Exports the current report to CSV using the column order in docs/report-columns.md.'),
  entry('code-review', 'bundled', 'Reviews code changes, pull requests, diffs, and AI-generated code for correctness, security, design, tests, readability, and performance, and writes clear, prioritized, actionable feedback. Use whenever the user asks to review, critique, audit, or sanity-check code or a PR, asks "is this good", "what\'s wrong with this", or "can you look over this diff", and also to self-review your own changes before reporting them as done.'),
  entry('debugging', 'bundled', 'A systematic, evidence-driven method for finding and fixing bugs, crashes, wrong output, flaky tests, performance regressions, race conditions, memory leaks, and environment-specific failures. Use whenever something is broken, throws an error, behaves differently than expected, works locally but fails elsewhere, fails intermittently, or the user pastes a stack trace or error log.'),
  entry('frontend-engineering', 'bundled', 'Builds, reviews, and refactors production-quality frontend code (HTML, CSS, JavaScript/TypeScript, React and similar component frameworks) with accessibility, performance, responsiveness, and design quality built in. Use whenever the task involves a UI, web page, component, form, layout, styling, client-side state, or turning a design or idea into working interface code.'),
  entry('security-review', 'bundled', 'Performs defensive security review and threat modeling of code, architecture, configuration, dependencies, CI/CD pipelines, and LLM or agent systems, mapped to the OWASP Top 10:2025, and produces prioritized findings with concrete fixes. Defensive use only; does not build malware or exploits.'),
  entry('software-engineering-workflow', 'bundled', 'The default end-to-end workflow for any software task: clarify the goal, explore the codebase, plan small steps, implement incrementally, verify with tests and tooling, review the diff, and report honestly.'),
  entry('technical-writing', 'bundled', 'Writes and improves technical documentation: READMEs, API and reference docs, tutorials, how-to guides, architecture docs, runbooks, changelogs, release notes, pull request descriptions, commit messages, and code comments, using the Diataxis structure and plain-language principles.'),
  entry('testing-strategy', 'bundled', 'Designs and writes effective automated tests (unit, integration, contract, end-to-end, property-based) and decides what to test, how, and at which level. Covers test structure, doubles and mocking policy, determinism, flaky tests, test data, TDD, coverage and mutation testing.'),
  entry('typescript-engineering', 'bundled', 'Writes and reviews type-safe, maintainable TypeScript and modern JavaScript for Node.js, browsers, and libraries: strict tsconfig, type design (unions, generics, narrowing, branded types), runtime validation with Zod, async patterns, error handling.')
]

const crowd: SkillSummary[] = Array.from({ length: 34 }, (_, index) =>
  entry(`team-playbook-${String(index + 1).padStart(2, '0')}`, index % 3 === 0 ? 'agents' : 'cubex', `Steps the team follows for recurring task number ${index + 1}, with the checks to run before and after.`))

/**
 * `?skills=none` lists no skills, `?skills=many` adds enough to scroll, `?skills=slow` answers after three seconds,
 * `?skills=fail` makes the list unreadable, and `?skills=gone` makes the main process refuse any skill turn the way
 * it does when a skill was removed after it was listed.
 */
export const seed: PreviewSeed = {
  api: (flags) => {
    const mode = flags.get('skills')
    return {
      listSkills: async () => {
        if (mode === 'slow') await new Promise((resolve) => setTimeout(resolve, 3000))
        if (mode === 'fail') throw new Error('The skills could not be read.')
        return mode === 'none' ? [] : mode === 'many' ? [...sample, ...crowd] : sample
      },
      ...(mode === 'gone' ? {
        startChat: async (request: ChatStartRequest) => {
          if (request.skill) throw new Error(skillLoadFailure(request.skill, 'no skill with that name is available in this task. Type / in the message box to see the ones you can use.'))
          return { streamId: request.streamId ?? 'browser' }
        }
      } : {})
    }
  }
}
