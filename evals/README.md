# Cubex evals

These evals measure how well a real model does small, real coding tasks inside Cubex's actual agent loop
(`ChatService`, its tools, its system prompt, its shell). Change a prompt or a tool, run the suite before and after,
and compare the numbers.

Each task is a folder the model is given as a workspace, a prompt a person would type, and a check that decides
objectively whether the workspace ended up right. Nothing is judged by a model.

## Running

You need Node 22.18 or newer on PATH (the fixtures run TypeScript tests with `node --test`) and, for the Python
tasks, `python` or `python3` (they are skipped when it is missing).

```sh
# Any provider Cubex supports, from environment variables:
CUBEX_EVAL_KIND=openai-compat \
CUBEX_EVAL_BASE_URL=https://api.example.com/v1 \
CUBEX_EVAL_API_KEY=... \
CUBEX_EVAL_MODEL=some-model \
npm run eval

# Or a provider you already saved in Cubex (its key is read the way the app reads it, and never printed):
npm run eval:app -- --provider "My Gateway" --model some-model [--user-data <dir>] [--tasks a,b] [--repeat 3]
```

`npm test` never runs the evals (they are not in `vitest.config.ts`), because they call a paid model.

| Variable | Meaning |
| --- | --- |
| `CUBEX_EVAL_KIND` | `openai-compat`, `openai`, `anthropic`, `gemini` (also `ollama`, `lmstudio`, `llamacpp`, `custom`), or `stub` |
| `CUBEX_EVAL_MODEL` | model id |
| `CUBEX_EVAL_BASE_URL` | endpoint, where the provider has no fixed one |
| `CUBEX_EVAL_API_KEY` | key; removed from the process environment as soon as it is read, so the agent's shell and the checks never see it |
| `CUBEX_EVAL_TASKS` | comma-separated task names to run (default all) |
| `CUBEX_EVAL_REPEAT` | runs per task (default 1); use 3 or more to see flakiness |
| `CUBEX_EVAL_CONCURRENCY` | runs at the same time (default 2) |
| `CUBEX_EVAL_EFFORT` | reasoning effort passed to the model (`low`, `medium`, `high`, ...) |
| `CUBEX_EVAL_TIMEOUT_SEC` | cap on every task's timeout, for a quick smoke run |
| `CUBEX_EVAL_KEEP=1` | keep each run's workspace and print its path in the results |
| `CUBEX_EVAL_PROVIDER_JSON` | the rest of a saved provider's settings (API mode, capabilities, headers); `eval:app` sets it |

`eval:app` also takes `--list` (show the saved providers) and `--dry-run` (resolve the provider and say whether a key
was found, without running anything). It must be an Electron script because the app's keys are encrypted with
Electron's `safeStorage`, which only an Electron process on the app's own user-data folder can decrypt.

Runs use permission mode `bypass`, so nothing waits for an approval. A question or plan review from the agent is
answered automatically and counted as an intervention.

### Without a model

`CUBEX_EVAL_KIND=stub npm run eval` runs the whole pipeline against a scripted provider that replays each task's
reference solution through the real loop with the real tools. It makes no network calls and should score every task, which
proves the runner, the checks and the report work. `npm run eval:validate` goes further and checks every task alone:
its check must fail on the untouched fixture and pass with the reference solution. Run it after adding a task.

## Results

Each run prints a markdown table and writes `evals/results/<timestamp>-<model>.json` (ignored by git) with the
settings, the git commit, and for every run its pass/fail, the check's output, the final text, the files changed and
the metrics below. A task that times out, errors or crashes is a failed run; it never stops the others.

| Metric | Meaning |
| --- | --- |
| Pass | runs whose check exited 0 (`2/3 flaky` when repeated) |
| Rounds | model requests the loop made; fewer is quicker and cheaper |
| Tool calls | calls the agent made, with a count by tool name in the JSON |
| Tool errors | calls that ended in the error state: a bad edit, a refused or repeated call, a command that exits non-zero (so a test run that fails counts) |
| Input / output tok | tokens the provider reported for the run, summed over its requests; the total row sums all runs |
| Time | wall-clock seconds, from the start of the run to the end of its check |
| interventions, retries | in the JSON: approvals or questions the runner answered, and provider attempts that were retried |
| promptHash, toolsOffered | in the JSON: a fingerprint of the first request's system prompt (workspace path excluded) and the tool list, so a result can be tied to the prompt that produced it |

Compare two result files only when the model, the tasks and the repeat count match. One run per task is noisy:
use `CUBEX_EVAL_REPEAT=3` or more before drawing conclusions from a difference of a task or two. To compare two versions,
run both at the same moment, so they meet the same provider, and then:

```sh
node evals/compare.mjs <before.json> <after.json> --input 0.15 --output 0.5 --cached 0.03 --write 0.15
```

It prints pass rates, tokens, cost and time, with a sign test over the tasks. [BENCHMARKS.md](BENCHMARKS.md) is the latest
comparison.

Three more variables test particular conditions:

| Variable | Meaning |
| --- | --- |
| `CUBEX_EVAL_FAULTS` | network trouble on demand: `busy:5:4` makes every 5th request meet four 503s, and `cut:7` drops the connection part way through every 7th |
| `CUBEX_EVAL_WINDOW` | the model's context window in tokens, to see what happens as a small one fills up |
| `CUBEX_EVAL_PROFILE` | `full` or `lean`, to compare the two setups on one model |

## Adding a task

Make `evals/tasks/<name>/` with:

- `task.json`: `{ "title", "prompt", "timeoutSec", "mode"?, "requires"?, "stub"? }`. `prompt` is exactly what is sent.
  `mode` defaults to `bypass`. `requires: ["python"]` skips the task when the program is missing. `stub` configures the
  scripted provider: `answer` (its final text) and `command` (a command it runs through `run_command`).
- `fixture/`: the project the model starts with, copied to a fresh temp folder per run. Keep it dependency-free
  (`node:test`, or Python `unittest`): there is no `npm install`. Git does not normalize line endings in `evals/`
  (`.gitattributes`), so CRLF fixtures survive. `gen-fixtures.mjs` produces the two generated ones.
- `check.mjs` (or `"checkCommand": "<shell command>"` in task.json, run in the workspace): started as
  `node check.mjs <workspace> <answerFile>`; exit 0 passes, anything else fails, and what it prints is kept as the
  reason. It also gets the environment variables `CUBEX_EVAL_FIXTURE` (the untouched fixture, to see what changed),
  `CUBEX_EVAL_TASK_DIR`, `CUBEX_EVAL_ANSWER` and `CUBEX_EVAL_ANSWER_FILE` (the agent's last message, for a question).
  `lib/checkKit.mjs` has helpers: `unchanged`, `onlyTouched`, `changes`, `scratchCopy`, `addHidden`, `nodeTest`, ...
- `hidden/` (optional): tests the agent never sees. The check copies them into a scratch copy of the workspace, so a
  model cannot pass by editing the tests it was shown.
- `solution/` (optional but expected): files overlaid on the fixture to make the check pass. The stub provider writes
  them with `write_file`, and `eval:validate` uses them.

Good checks judge behavior rather than wording, fail on the untouched fixture, tolerate any reasonable solution, and
leave the files the task did not mention alone. Then run `npm run eval:validate`.
