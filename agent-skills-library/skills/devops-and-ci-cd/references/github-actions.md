# GitHub Actions: hardened patterns

Concepts transfer to GitLab CI, CircleCI, Buildkite, and others.

## Contents
1. Threat model
2. Hardening rules
3. Script injection
4. Risky triggers
5. Reference workflow
6. Deploy workflow with OIDC
7. Performance and cost
8. Reusable workflows and composite actions
9. Review checklist

## 1. Threat model
A workflow is code running with credentials. Attackers target: untrusted input reaching shells, third-party actions that get compromised, over-permissive tokens, secrets exposed to forks, self-hosted runners persisting state, and cache poisoning.

## 2. Hardening rules
- **Default-deny permissions.** Set `permissions: {}` (or `contents: read`) at workflow level, then grant per job only what is needed (`pull-requests: write`, `id-token: write`, `packages: write`).
- **Pin third-party actions to a full-length commit SHA** with a version comment; floating tags can be repointed after a compromise. Let Dependabot or Renovate update pins. Consider an org policy that requires SHA pinning.
- `actions/checkout` with `persist-credentials: false` unless the job pushes.
- **Use OIDC** to obtain short-lived cloud credentials instead of storing access keys as secrets.
- Scope secrets to **environments** with required reviewers; do not expose secrets to jobs that run untrusted code.
- Use `concurrency` to cancel superseded PR runs and serialize deployments.
- Set `timeout-minutes` on jobs; avoid unbounded runs.
- Prefer GitHub-hosted ephemeral runners. If self-hosted: ephemeral, isolated, never on public repos.
- Restrict allowed actions at org level (allowlist verified creators and your own).
- Enable secret scanning with push protection, code scanning, and dependency review on PRs.
- Keep the default `GITHUB_TOKEN` read-only at the repo/org settings level.

## 3. Script injection
`${{ ... }}` expressions are substituted into the script text before the shell runs, so attacker-controlled values (issue titles, PR titles and bodies, branch names, commit messages, comment bodies) can inject commands.

Unsafe:
```yaml
- run: echo "PR title: ${{ github.event.pull_request.title }}"
```
Safe: pass through an environment variable and quote it.
```yaml
- env:
    PR_TITLE: ${{ github.event.pull_request.title }}
  run: echo "PR title: $PR_TITLE"
```
Also avoid writing untrusted values to `GITHUB_ENV`/`GITHUB_OUTPUT`/`GITHUB_PATH` without sanitizing (newline injection). Prefer official actions' inputs over inline scripts for untrusted data.

## 4. Risky triggers
- `pull_request_target` and `workflow_run` run with a privileged token and secrets in the context of the base repo. **Never check out and execute PR head code** in these workflows. If you must, split into an unprivileged build workflow (`pull_request`) that uploads artifacts and a privileged workflow that only handles them as data.
- `issue_comment` and `issues` triggers process untrusted text; validate the actor's permissions before acting.
- Fork PRs do not get secrets under `pull_request`; that is a feature.
- Caches: do not restore caches written by untrusted PRs into privileged jobs (scope cache keys by branch/ref).

## 5. Reference workflow (build, test, scan)
```yaml
name: ci
on:
  pull_request:
  push:
    branches: [main]

permissions: {}

concurrency:
  group: ci-${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}

jobs:
  test:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    permissions:
      contents: read
    services:
      postgres:
        image: postgres:16
        env: { POSTGRES_PASSWORD: postgres }
        ports: ["5432:5432"]
        options: >-
          --health-cmd "pg_isready -U postgres" --health-interval 5s
          --health-timeout 5s --health-retries 10
    steps:
      - uses: actions/checkout@<full-commit-sha>   # vX.Y.Z
        with: { persist-credentials: false }
      - uses: astral-sh/setup-uv@<full-commit-sha>  # vX.Y.Z
        with: { enable-cache: true }
      - run: uv sync --frozen
      - run: uv run ruff check . && uv run ruff format --check .
      - run: uv run pytest -q --maxfail=1 --junitxml=report.xml
        env:
          DATABASE_URL: postgresql://postgres:postgres@localhost:5432/postgres
      - if: always()
        uses: actions/upload-artifact@<full-commit-sha>  # vX.Y.Z
        with: { name: test-report, path: report.xml }

  codeql:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      security-events: write
    steps:
      - uses: actions/checkout@<full-commit-sha>
        with: { persist-credentials: false }
      - uses: github/codeql-action/init@<full-commit-sha>
        with: { languages: python }
      - uses: github/codeql-action/analyze@<full-commit-sha>
```
Replace `<full-commit-sha>` with the real 40-character SHA of the release you reviewed; do not use branch names.

## 6. Deploy workflow with OIDC
```yaml
name: deploy
on:
  push:
    tags: ["v*"]

permissions: {}

jobs:
  build:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
      id-token: write        # for keyless signing
    outputs:
      digest: ${{ steps.push.outputs.digest }}
    steps:
      - uses: actions/checkout@<sha>
        with: { persist-credentials: false }
      - uses: docker/setup-buildx-action@<sha>
      - uses: docker/login-action@<sha>
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - id: push
        uses: docker/build-push-action@<sha>
        with:
          push: true
          tags: ghcr.io/${{ github.repository }}:${{ github.sha }}
          provenance: true
          sbom: true
      - uses: sigstore/cosign-installer@<sha>
      - run: cosign sign --yes ghcr.io/${{ github.repository }}@${{ steps.push.outputs.digest }}

  deploy-prod:
    needs: build
    runs-on: ubuntu-latest
    environment: production        # required reviewers configured on the environment
    permissions:
      id-token: write
      contents: read
    steps:
      - uses: aws-actions/configure-aws-credentials@<sha>
        with:
          role-to-assume: arn:aws:iam::123456789012:role/gha-deploy-prod
          aws-region: eu-central-1
      - run: ./scripts/deploy.sh "ghcr.io/${{ github.repository }}@${{ needs.build.outputs.digest }}"
```
The cloud role's trust policy must restrict `sub` claims to this repo, branch or tag, and environment.

## 7. Performance and cost
- Cache dependencies by lockfile hash (setup actions have built-in caching); cache build layers (`cache-from/to type=gha`).
- Use path filters and change detection to skip unaffected jobs in monorepos; keep a required aggregate job for branch protection.
- Shard tests in a matrix; run fast checks first; fail fast (`--maxfail`).
- Use larger runners only when measured; cancel superseded runs; set retention for artifacts and logs.

## 8. Reusable workflows and composite actions
- Put shared pipeline logic into reusable workflows (`workflow_call`) or composite actions in an internal repo; version by tag and pin by SHA from consumers; pass secrets explicitly (`secrets: inherit` only within trust boundaries).
- Keep the surface small and documented; test with a sample repo.

## 9. Review checklist
- [ ] `permissions` minimal at workflow and job level
- [ ] Third-party actions pinned to SHAs
- [ ] No untrusted `${{ }}` inside `run:` scripts
- [ ] No privileged trigger runs PR code
- [ ] OIDC instead of static cloud keys; environment protections for production
- [ ] Timeouts, concurrency, and caching set
- [ ] Artifacts signed and SBOM/provenance produced for releases
