---
name: devops-and-ci-cd
description: Designs and reviews build, test, and deployment automation and infrastructure: CI/CD pipelines (GitHub Actions and similar), Docker images and Compose, Kubernetes basics, infrastructure as code (Terraform), release strategies, environments, secrets, supply chain hardening, and DORA delivery metrics. Use whenever the user asks about pipelines, workflows, Dockerfiles, containers, deployments, releases, rollbacks, environment configuration, IaC, cloud infrastructure, or making delivery faster, safer, and more reliable.
license: MIT
metadata:
  category: operations
  version: "1.0"
---

# DevOps and CI/CD

Goal: small changes flow from commit to production quickly, safely, repeatably, and with fast feedback. Automate everything a human would otherwise do twice.

## 1. Principles

- **Everything as code**: pipelines, infrastructure, configuration, dashboards, alerts live in version control and go through review.
- **Build once, deploy many**: one immutable artifact (container image, package) promoted through environments; configuration differs, artifacts do not.
- **Fast feedback**: fail early and cheaply. Order pipeline stages by speed and signal; keep the main gate under ~10 minutes.
- **Trunk-based, small batches**: merge small changes often behind feature flags; long-lived branches create risky big-bang merges.
- **Reproducible**: pinned tool versions and lockfiles; hermetic builds; the same commands locally and in CI (`make ci`, task runner scripts).
- **Secure by default**: least privilege, no long-lived secrets, pinned dependencies, signed artifacts.
- **Observable and reversible**: every release is monitored and can be rolled back or disabled quickly.

## 2. Pipeline stages (typical)

1. **Trigger**: PR, push to main, tag, schedule, manual dispatch.
2. **Static checks**: format, lint, type check, secret scan, license and dependency audit.
3. **Build**: compile/bundle, produce artifact(s) once; cache dependencies keyed by lockfile hash.
4. **Test**: unit (parallel), integration (with service containers), contract tests; collect coverage and test reports.
5. **Security**: SAST (CodeQL, Semgrep), dependency scan (osv-scanner, Trivy), container scan, IaC scan.
6. **Package and publish**: build container image, tag with commit SHA (and semver for releases), push to registry, generate SBOM, sign (cosign), attach provenance.
7. **Deploy to staging**: automated, with smoke and end-to-end tests.
8. **Deploy to production**: automated (continuous deployment) or one-click approval (continuous delivery); progressive rollout with automated health checks and rollback.
9. **Post-deploy**: verification, synthetic checks, release notes, notify.

Design rules: PR pipelines validate without deploying; only protected branches or tags can deploy; environments have required reviewers where policy needs them; pipelines are idempotent and safe to re-run; use concurrency groups to cancel superseded runs and serialize deploys.

## 3. Delivery metrics (DORA)

Track how well delivery performs and improve the constraint:
- **Deployment frequency**: how often you deploy to production.
- **Lead time for changes**: commit to running in production.
- **Change failure rate**: share of deployments causing incidents/rollbacks.
- **Failed deployment recovery time** (time to restore service).
- Also useful: rework rate (unplanned deployments to fix problems), and reliability against SLOs.
Use them to find bottlenecks, not to rank teams. Small batch size, automated testing, trunk-based development, and loosely coupled architecture consistently improve them.

## 4. Release strategies

| Strategy | How | Rollback | Use when |
|---|---|---|---|
| Rolling | Replace instances gradually | Roll back to previous version | Default for stateless services |
| Blue/green | Two full environments, switch traffic | Switch back instantly | Need instant rollback; can afford double capacity |
| Canary | Send small percent of traffic to the new version, analyze metrics, expand | Stop and revert canary | High-traffic systems; risky changes |
| Feature flags | Deploy dark, enable per user/segment | Turn the flag off | Decouple deploy from release; experiments |
| Shadow / mirror | Copy traffic to new version, ignore responses | n/a | Validate new implementations under real load |

Database changes use expand and contract (`backend-engineering`) so old and new code versions work during rollout. Version APIs and messages compatibly. Have a rollback plan for every release and rehearse it.

## 5. Environments and configuration

- Environments: local, CI (ephemeral), staging (production-like), production. Keep staging close to production in topology and data shape (with anonymized data).
- Configuration via environment variables or a config service; no environment-specific code branches; validate config at startup.
- Secrets in a secret manager (AWS Secrets Manager, GCP Secret Manager, Vault, Azure Key Vault, SOPS/age for encrypted-in-git); injected at deploy/runtime; rotated; never baked into images or logs.
- Prefer workload identity/OIDC federation over static cloud keys.
- Ephemeral preview environments per PR for UI and integration review, destroyed on merge.

## 6. Infrastructure as code

- Use Terraform/OpenTofu, Pulumi, CloudFormation/CDK, or Crossplane; keep state remote, encrypted, locked (S3+DynamoDB/GCS/Terraform Cloud); never edit resources by hand (drift).
- Structure: small reusable modules, one root module per environment/stack, pinned provider and module versions, consistent naming and tagging (owner, environment, cost center).
- Workflow: `fmt` and `validate` -> `plan` on PR (post the plan as a comment) -> review -> `apply` on merge from the pipeline with least-privileged role. Treat destroy/replace lines in plans as high-risk.
- Scan IaC (Checkov, tfsec/Trivy, OPA/Conftest, kube-linter) and detect drift on a schedule.
- Least-privilege IAM; no wildcard policies; separate accounts/projects per environment; guard rails with organization policies.
- Cost controls: budgets and alerts, autoscaling limits, lifecycle rules for storage, right-sizing reviews.

## 7. Containers and orchestration (summary)

Docker rules and examples: `references/docker.md`. Kubernetes essentials:
- Set resource `requests` and `limits`; readiness, liveness, and startup probes; `PodDisruptionBudget`; multiple replicas across zones; `HorizontalPodAutoscaler`.
- Run as non-root, `readOnlyRootFilesystem`, drop capabilities, no privileged containers, `seccompProfile: RuntimeDefault`.
- Use `Deployment` for stateless, `StatefulSet` for stateful, `Job/CronJob` for batch; config via `ConfigMap`, secrets via external secret operators.
- Network policies default deny; namespaces per team/environment; RBAC least privilege.
- Package with Helm or Kustomize; GitOps (Argo CD, Flux) so the cluster converges to what git declares.
- Consider managed services and simpler platforms (Cloud Run, ECS Fargate, Fly.io, App Service) before Kubernetes unless you need its features and have platform capacity.

## 8. Supply chain and pipeline security

Full details in `references/github-actions.md`. Essentials:
- Pin third-party actions/images by immutable digest or full commit SHA; update via automation.
- Minimal `permissions:` for `GITHUB_TOKEN`; OIDC to cloud; environment protection rules.
- Never interpolate untrusted input (`github.event.*`, PR titles, branch names) directly into shell scripts; pass through environment variables.
- Treat `pull_request_target`, `workflow_run`, and self-hosted runners as high risk.
- Generate SBOMs, sign images and verify signatures on deploy, record provenance (SLSA), scan images.

## 9. Observability handoff

Pipelines should annotate deploys in dashboards, tag traces/logs with version and commit, run post-deploy smoke checks, and auto-rollback on SLO/burn-rate alarms. See `backend-engineering/references/reliability-and-observability.md`.

## 10. Pipeline review checklist

- [ ] One command reproduces CI locally; tool versions pinned
- [ ] Caches keyed by lockfile; total time within budget; flaky tests quarantined
- [ ] Artifact built once, versioned by commit SHA, immutable
- [ ] Least-privilege permissions; no long-lived secrets; actions pinned
- [ ] Security scans (deps, code, image, IaC, secrets) block on high severity
- [ ] Deploys are automated, idempotent, serialized per environment, and observable
- [ ] Rollback tested; database migrations backward compatible
- [ ] Notifications and ownership clear; runbooks linked
- [ ] Infrastructure changes reviewed via plan output; drift monitored

## Reference files

- `references/github-actions.md`: hardened workflow patterns and complete example
- `references/docker.md`: Dockerfile best practices, multi-stage examples, Compose, image security
