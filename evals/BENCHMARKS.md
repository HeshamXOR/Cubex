# Benchmarks: harness changes of November 2026

Measured on 2026-11-06 against the last release commit (`622c25a`), through the Pizzarouter gateway. Old and new code ran
side by side at the same moment, so both met the same gateway. Costs use the gateway's own prices from `/api/pricing`.
`node evals/compare.mjs` produced the tables, and the p-values are sign tests over tasks. With so few tasks, a p above 0.05
means the difference could be noise.

## Summary

| Claim | Evidence | Verdict |
| --- | --- | --- |
| Turns survive dropped connections and busy spells | 3/48 runs finish before, 48/48 after | Strong, but injected faults |
| Small context windows work better | 36/38 passed before, 38/38 after, 12% cheaper, 15% faster | Promising, not significant (p = 0.17) |
| The lean setup is cheaper for a flash model | Same pass rate, 42% less cost than full | Strong (19 of 19 tasks, p < 0.0001) |
| New code is cheaper on a healthy gateway | Claude +2%, GLM -3% | No change |
| New code passes more on a healthy gateway | Claude 48/48 both, GLM 46/48 to 47/48 | No change |
| The Messages route saves money on Claude | Cache share 90% on both routes | No: not measurable on this gateway |
| Retries rescue a model that is busy for many minutes | 0/8 both, for DeepSeek and GPT | No: the wait only takes longer |

## Fault injection

The scripted model replays each task's reference solution, so a failed run can only be the harness. Every 3rd request has
its connection dropped part way, and every 4th meets a server answering 503 five times. 16 tasks, 3 runs each.

| | Before | After |
| --- | --- | --- |
| Runs finished | 3/48 (6%) | 48/48 (100%) |

```bash
CUBEX_EVAL_KIND=stub CUBEX_EVAL_REPEAT=3 CUBEX_EVAL_FAULTS=busy:4:5,cut:3 npm run eval
```

These faults are deliberately harsh and much more frequent than a real gateway's. The number shows the mechanism works,
not how often a real session would have failed.

## Healthy gateway

16 tasks, 3 runs each.

| | Claude Haiku 5.5 before | after | GLM-5.3 Flash before | after |
| --- | --- | --- | --- | --- |
| Passed | 48/48 | 48/48 | 46/48 | 47/48 |
| Input tokens | 4.74M | 4.70M | 3.22M | 3.16M |
| Served from cache | 90% | 90% | 43% | 43% |
| Cost | $0.147 | $0.150 | $0.357 | $0.347 |
| Time per run | 32s | 33s | 35s | 36s |

Nothing here is significant. Both models pass nearly everything on either version, so these tasks cannot separate them.

## Harder tasks

3 new tasks (`noisy-logs`, `misleading-error`, `signature-change`), 3 runs each.

| | Haiku before | after | GLM before | after |
| --- | --- | --- | --- | --- |
| Passed | 9/9 | 9/9 | 9/9 | 9/9 |
| Cost | $0.021 | $0.022 | $0.114 | $0.111 |
| Tool errors per run | 1.11 | 1.22 | 1.11 | 0.67 |

Still too easy for these models, and no difference that means anything. A suite that separates current models needs longer
and harder tasks than these.

## Small context window

GLM-5.3 Flash with a 32K window (`CUBEX_EVAL_WINDOW=32000`), 19 tasks, 2 runs each. This is where the research predicted
that shortening old tool output would help.

| | Before | After | Change |
| --- | --- | --- | --- |
| Passed | 36/38 | 38/38 | |
| Timed out | 1 | 0 | |
| Input tokens | 2.60M | 2.33M | -10% |
| Cost per passed run | $0.0068 | $0.0057 | -17% |
| Time per run | 46s | 39s | -15% |

13 tasks got cheaper and 6 dearer (p = 0.17). It points the way the studies do, but this sample does not prove it.

## Lean against full

GLM-5.3 Flash on the new code, 19 tasks, 3 runs each. Lean offers 18 tools and a shorter prompt, and full offers 26.

| | Lean | Full |
| --- | --- | --- |
| Passed | 56/57 | 56/57 |
| Input tokens | 3.99M | 6.35M |
| Cost | $0.417 | $0.730 |
| Time per run | 47s | 51s |

All 19 tasks cost more on full (p < 0.0001), so flash models stay lean. This says nothing about large hosted models such as
GLM-5.3 or Kimi K3, which were not tested.

## Busy models

DeepSeek V4.1 Flash and GPT-5.4 were busy on every endpoint for the whole test. 4 tasks, 2 runs each.

| | Before | After |
| --- | --- | --- |
| Passed | 0/16 | 0/16 |
| Time to give up, per run | 62s | 210s |

Longer retries help a short busy spell, and do nothing for an outage that lasts longer than they wait. A person in that
situation is better served by another model. After this run the limit came down from 8 attempts to 6, to give up sooner.

## Not measured

- How often a real session hits a dropped stream. The fix is shown by injected faults, and no failure of that kind happened
  by itself during these runs.
- Claude on a gateway that does not cache for it on Chat Completions. This gateway caches 90% on both routes.
- Large hosted open models, which were busy or not run.
- Stall detection. Tool errors per run on GLM moved from 1.11 to 0.67 on the hard tasks, but Haiku moved the other way, and
  no task failed by looping. It is backed by unit tests and by other harnesses' experience, not by these numbers.
