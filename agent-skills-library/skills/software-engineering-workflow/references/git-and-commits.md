# Git and commits reference

## Contents
1. Principles
2. Branching models
3. Commit messages
4. Pull request hygiene
5. History editing rules
6. Everyday commands
7. Recovery cookbook
8. Repository hygiene

## 1. Principles
- Commit early and often locally; publish clean, logical history.
- One commit = one logical change that builds and passes tests. Refactors, formatting, and behavior changes go in separate commits.
- Never commit secrets, credentials, large binaries, generated files, or local config.
- Never rewrite history that others have pulled (shared branches, `main`) without agreement.

## 2. Branching models
- **Trunk-based development** (recommended for most teams): short-lived branches (hours to 2 days) merged to `main` frequently behind feature flags; requires strong CI. Correlates with high delivery performance in DORA research.
- **GitHub Flow**: feature branch, PR, review, merge to `main`, deploy.
- **Git Flow / release branches**: only when you must maintain multiple released versions.
- Branch names: `feat/short-description`, `fix/issue-123-null-crash`, `chore/upgrade-deps`, or `user/topic` per team convention.
- Protect `main`: require passing CI, at least one review, linear history if the team prefers, and signed commits if policy demands.

## 3. Commit messages
Format (Conventional Commits works well with changelog and version automation):
```
<type>(<scope>): <imperative summary, 50 to 72 chars, no period>

<body: what and why, wrapped at ~72 chars; not how>

<footer: BREAKING CHANGE: ..., Closes #123, Co-authored-by: ...>
```
Types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`. Breaking change: `feat!:` or a `BREAKING CHANGE:` footer.

Good: `fix(auth): reject expired refresh tokens before rotation`
Bad: `fixed stuff`, `wip`, `update`, `changes for review`.

Body answers: what was wrong or missing, why this approach, side effects, links to tickets or docs. Reference issues with `Closes #123`.

## 4. Pull request hygiene
- Small PRs (under ~400 changed lines where possible) are reviewed faster and better. Stack PRs for large work.
- Title states the change; description states: **context and goal**, **approach**, **testing done**, **risks and rollout**, **screenshots or recordings** for UI, **follow-ups**.
- Self-review before requesting review; leave comments on tricky spots.
- Keep CI green; do not merge failing checks; do not force merge around reviews.
- Respond to every review comment (fix, explain, or agree to follow up). Re-request review after changes.
- Squash-merge for noisy branch history; merge commits or rebase-merge when individual commits are meaningful. Follow the repo convention.

## 5. History editing rules
- Local, unpublished branch: rebase and squash freely (`git rebase -i origin/main`, `git commit --fixup` with `--autosquash`).
- Published branch used only by you: force push with lease (`git push --force-with-lease`), never bare `--force`.
- Shared branches and `main`: do not rewrite; use `git revert`.
- Prefer `git pull --rebase` (or `pull.rebase=true`) to avoid noisy merge commits on feature branches.

## 6. Everyday commands
```bash
git status -sb                      # short status with branch
git diff / git diff --staged        # unstaged / staged changes
git add -p                          # stage hunks interactively
git commit -m "..." / --amend       # commit / amend last (unpublished only)
git switch -c feat/x                # new branch
git fetch --prune && git rebase origin/main
git log --oneline --graph --decorate -20
git log -S 'symbol' -p -- path      # who introduced/removed a string
git blame -w -C path                # ignore whitespace, detect moves
git stash push -m "msg" / pop
git bisect start; git bisect bad; git bisect good <sha>; git bisect run ./test.sh
git worktree add ../repo-hotfix hotfix-branch   # parallel checkouts
git restore --staged path / git restore path
```

## 7. Recovery cookbook
| Situation | Command |
|---|---|
| Undo last commit, keep changes staged | `git reset --soft HEAD~1` |
| Undo last commit, keep changes unstaged | `git reset HEAD~1` |
| Discard local changes to a file | `git restore path` (destructive) |
| Undo a pushed commit safely | `git revert <sha>` |
| Committed to the wrong branch | `git switch -c right-branch`; on the wrong one `git reset --hard origin/<branch>` after confirming the commit is safe on the new branch |
| Lost commits after a bad reset or rebase | `git reflog`, then `git switch -c rescue <sha>` |
| Resolve conflicts | Edit markers, `git add`, `git rebase --continue` (or `git merge --continue`); `git rebase --abort` to back out |
| Secret committed | Rotate the secret immediately (assume compromised); then remove from history with `git filter-repo` and force push; notify the team |
| Accidentally committed large file | Remove with `git filter-repo`; add to `.gitignore`; consider Git LFS |
Before any destructive command (`reset --hard`, `clean -fd`, `push --force`), verify with `git status`, `git stash` or a backup branch.

## 8. Repository hygiene
- `.gitignore` for build outputs, dependencies, env files, editor and OS files; commit lockfiles.
- `.env.example` documents required variables without values.
- Pre-commit hooks (pre-commit, husky, lefthook) for format, lint, secret scanning (gitleaks, trufflehog); the same checks must run in CI, since hooks can be skipped.
- `CODEOWNERS` for review routing; `SECURITY.md` for vulnerability reporting; `CONTRIBUTING.md` for workflow.
- Tag releases with semantic versions (`v1.4.2`) and generate changelogs from Conventional Commits or curated notes.
- Enable secret scanning, dependency alerts (Dependabot or Renovate), and code scanning.
