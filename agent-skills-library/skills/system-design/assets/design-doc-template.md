# Design Doc: <Title>

- **Author(s):** | **Reviewers:** | **Status:** Draft / In review / Approved | **Last updated:** YYYY-MM-DD

## 1. Summary
Two or three sentences: what we are building and why, for whom.

## 2. Background and problem
Current state, pain, evidence (metrics, incidents, user feedback). Links.

## 3. Goals and non-goals
**Goals:** measurable outcomes.
**Non-goals:** explicitly out of scope.

## 4. Requirements
**Functional:** user stories / use cases.
**Non-functional:** scale, latency, availability, durability, consistency, security/compliance, cost, operability. Provide numbers and assumptions.

## 5. Proposed design
### 5.1 Architecture overview
Diagram (context and container level) and narrative of the main flows.
### 5.2 Components
Responsibility, technology, scaling approach, ownership for each.
### 5.3 Data model
Entities, relationships, keys, indexes, retention, PII classification.
### 5.4 APIs and contracts
Endpoints/events, schemas, error model, versioning, idempotency.
### 5.5 Key flows
Sequence diagrams for the critical paths, including failure paths.
### 5.6 Security and privacy
Trust boundaries, authn/z, secrets, encryption, audit, threat model summary.
### 5.7 Reliability and operations
Failure modes and mitigations, SLOs, monitoring/alerts, runbooks, capacity plan, backups and disaster recovery.

## 6. Alternatives considered
Each alternative with pros, cons, and why not chosen.

## 7. Rollout plan
Phases, migration and backfill, feature flags, testing strategy, rollback plan, success metrics and how they will be measured.

## 8. Risks and open questions
| Risk / question | Impact | Mitigation / owner | Due |
|---|---|---|---|

## 9. Cost estimate
Infrastructure, licenses, engineering time, ongoing operations.

## 10. Appendix
Benchmarks, calculations, glossary, references.
