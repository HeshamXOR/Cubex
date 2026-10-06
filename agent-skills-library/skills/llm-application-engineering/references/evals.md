# Evaluation reference for LLM features

## Contents
1. Why and when
2. Building the dataset
3. Metrics and graders
4. LLM-as-judge practices
5. Component vs end-to-end evals
6. Regression testing and CI
7. Online evaluation and monitoring
8. Agent evals
9. Common mistakes
10. Minimal harness sketch

## 1. Why and when
Evals convert "seems better" into evidence. Build them early (before extensive prompt tuning), grow them from real failures, and run them on every prompt, model, retrieval, or tool change. Ten to fifty well-chosen cases already reveal most problems; scale up as the product matures.

## 2. Building the dataset
- Source cases from real user inputs (sanitized), support tickets, logs, and domain expert examples; add synthetic variations to cover gaps (LLM-generated, then human-reviewed).
- Cover: typical cases, edge cases, ambiguous requests, adversarial and prompt-injection attempts, out-of-scope requests, long inputs, multilingual inputs (including Arabic/RTL if you serve them), typos, and safety-sensitive cases.
- Each case: `id`, input (and context/fixtures), expected output or reference answer or grading criteria, tags (category, difficulty), and notes about why it exists.
- Keep a **held-out** split not used for prompt tuning to detect overfitting to the dev set.
- Version the dataset; when the product changes, update it deliberately and record changes.
- Label with domain experts where correctness needs expertise; measure inter-annotator agreement.

## 3. Metrics and graders
Pick the cheapest grader that reliably measures the criterion:
| Grader | Use for | Notes |
|---|---|---|
| Exact match / regex / schema validation | Classification labels, extraction fields, format compliance | Fast, deterministic |
| Programmatic checks | Code runs and passes tests, SQL returns expected rows, JSON valid, citations exist in retrieved set, tool called with right args | Strongest signal when available |
| Similarity metrics (embedding cosine, ROUGE, BLEU) | Rough regression signal | Weak proxy for quality; use cautiously |
| Retrieval metrics (recall@k, MRR, NDCG, hit rate) | Search and RAG retrieval | Needs labeled relevant docs |
| LLM-as-judge with rubric | Helpfulness, faithfulness, tone, reasoning quality | Calibrate against humans |
| Human review | Ground truth, subjective quality, high-stakes | Costly; use samples and for calibrating automation |
| Pairwise preference (A vs B) | Comparing two versions | Randomize order to avoid position bias |

Report pass rate per category and overall, plus cost and latency. Track **safety/refusal metrics** (harmful compliance, over-refusal) alongside task success.

## 4. LLM-as-judge practices
- Write a **specific rubric** with observable criteria and scoring anchors ("1 = contradicts source; 3 = mostly supported; 5 = every claim supported by cited passage"). Grade one criterion per judge call for clarity.
- Provide the input, the output, reference/context, and ask for brief reasoning followed by a structured verdict (label/score) so results are parseable and auditable.
- Prefer categorical or binary judgments (pass/fail with reasons) over fine-grained 1-10 scales.
- Use a strong judge model, low temperature, and possibly multiple samples with majority vote.
- Known biases: position bias, verbosity bias, self-preference (models favor their own style), and sycophancy to stated opinions. Mitigate by randomizing order, controlling length, using a different model family for judging, and hiding the source model.
- **Calibrate**: label 50 to 100 cases by hand, measure agreement (accuracy, Cohen's kappa) between judge and humans, iterate on the rubric until agreement is acceptable, and re-check periodically.
- Judge results are a tool for ranking versions, not an absolute truth; spot-check failures manually.

## 5. Component vs end-to-end evals
- **Component evals** isolate a step (retriever, classifier, extractor, tool selector, summarizer) with focused datasets to locate faults quickly.
- **End-to-end evals** measure the user-visible outcome on realistic tasks.
- For RAG: measure retrieval (was the right chunk in the top k?) separately from generation (is the answer faithful to the retrieved context? does it address the question?). Fix retrieval first.
- For pipelines: check intermediate outputs so errors are attributable.

## 6. Regression testing and CI
- Run a fast **smoke suite** (20 to 50 cases, deterministic graders) on each PR; run the **full suite** nightly or before release.
- Set thresholds and compare against the last release baseline with confidence intervals; LLM outputs vary, so use multiple runs or larger samples for noisy metrics and avoid failing builds on tiny differences.
- Cache model responses for unchanged inputs to save cost; pin model versions for reproducibility; store outputs and grader reasons as artifacts.
- Every production bug becomes a new eval case.
- Tools: promptfoo, OpenAI Evals, Inspect (UK AISI), Braintrust, LangSmith, Langfuse, Arize Phoenix, DeepEval, Ragas (RAG), or a small custom pytest harness.

## 7. Online evaluation and monitoring
- Capture user feedback (thumbs, edits, retries, abandonment), escalation rates, and downstream outcomes.
- Sample production traces to a review queue; run automated judges on samples for drift detection (hallucination rate, refusal rate, format errors, latency, cost).
- A/B test prompt/model changes with guardrail metrics; roll out gradually with feature flags.
- Alert on spikes in errors, refusals, latency, token usage, and negative feedback.
- Respect privacy: redact PII in logs and eval sets; obey retention rules.

## 8. Agent evals
- Evaluate **outcomes** (task completed correctly, verified by environment state or tests) rather than exact step sequences, since many paths can be valid.
- Also track: number of steps/tool calls, cost, time, recoverability from errors, unsafe action attempts, and adherence to constraints.
- Use sandboxed, resettable environments with fixtures; run each task multiple times (pass@k, pass^k for consistency); read transcripts of failures to find tool-description problems, missing context, or looping.
- Include adversarial cases: injected instructions in tool results, ambiguous tasks that should trigger clarification, requests requiring refusal or human approval.

## 9. Common mistakes
- Evaluating only on hand-picked happy paths
- Tuning prompts on the same cases used to report results
- Trusting an uncalibrated judge; using the same model to generate and grade with no checks
- Measuring similarity scores instead of task success
- Ignoring variance; declaring wins from one run
- No baseline (previous version or trivial heuristic)
- Not tracking cost and latency alongside quality
- Letting the dataset go stale as the product changes

## 10. Minimal harness sketch
```python
import json, statistics as st
from dataclasses import dataclass

@dataclass
class Case: id: str; input: str; expected: dict; tags: list[str]

def run_eval(cases, system_under_test, graders):
    results = []
    for c in cases:
        out = system_under_test(c.input)            # returns dict with text, tokens, latency
        scores = {name: g(c, out) for name, g in graders.items()}   # each returns 0/1 or float
        results.append({"id": c.id, "tags": c.tags, "scores": scores,
                        "latency_ms": out["latency_ms"], "cost": out["cost"], "output": out["text"]})
    summary = {name: st.mean(r["scores"][name] for r in results) for name in graders}
    return summary, results

# usage: compare summaries between prompt versions; fail CI if a metric drops below threshold
```
Save `results` as JSONL for inspection and diffing between runs.
