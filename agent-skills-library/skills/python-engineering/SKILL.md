---
name: python-engineering
description: Writes idiomatic, typed, testable, production-grade Python: project layout and packaging with pyproject.toml, uv and Ruff tooling, type hints, dataclasses and Pydantic, exceptions, context managers, generators, asyncio, logging, configuration, performance basics, and FastAPI, Django, and data-science patterns. Use whenever the user is writing, reviewing, debugging, structuring, or packaging Python code or scripts, setting up a Python project, adding type hints, writing async code, or building Python services, CLIs, or libraries.
license: MIT
metadata:
  category: language
  version: "1.0"
---

# Python Engineering

Match the project's Python version, tools, and conventions first. When creating something new, use the defaults below. Verify library APIs against the installed version; Python tooling and libraries move quickly.

## 1. Project setup

Recommended layout (src layout keeps tests honest by requiring installation):
```
project/
  pyproject.toml
  uv.lock                 # or poetry.lock / requirements lock, committed
  README.md
  src/project_name/__init__.py
  src/project_name/...
  tests/
  .python-version
  .pre-commit-config.yaml
```
- **pyproject.toml** is the single source for metadata, dependencies, and tool config (PEP 621). Use dependency groups (PEP 735) or extras for dev, test, and docs dependencies.
- **uv** (fast resolver, installer, virtualenv, lockfile, Python version manager) is the common modern choice: `uv init`, `uv add httpx`, `uv add --dev pytest ruff`, `uv sync --frozen`, `uv run pytest`, `uv run python script.py`. If the project uses Poetry, PDM, pip-tools, or Hatch, keep using it.
- Always work in a virtual environment; never `pip install` into the system Python; commit the lockfile for applications; libraries declare version ranges, applications pin exactly through the lock.
- **Ruff** for lint and format (`ruff check --fix`, `ruff format`); enable rule sets like `E,F,I,B,UP,SIM,C4,PL,RUF` plus `S` (security) and `ASYNC` as fits.
- **Type checking** with the project's checker (mypy, pyright, or newer Rust-based checkers such as ty); run in CI; enable `strict` or gradual strictness per package.
- **pytest** for tests; **pre-commit** for hooks; CI runs the same commands.
- Single-file scripts can declare dependencies inline (PEP 723) and run with `uv run script.py`.

Example config:
```toml
[project]
name = "project-name"
version = "0.1.0"
requires-python = ">=3.11"
dependencies = ["httpx>=0.27", "pydantic>=2.7"]

[dependency-groups]
dev = ["pytest>=8", "pytest-cov", "ruff", "mypy"]

[tool.ruff]
line-length = 100
[tool.ruff.lint]
select = ["E", "F", "I", "B", "UP", "SIM", "C4", "RUF", "S", "ASYNC"]
[tool.ruff.lint.per-file-ignores]
"tests/**" = ["S101"]

[tool.mypy]
strict = true
python_version = "3.11"

[tool.pytest.ini_options]
addopts = "-q --strict-markers"
testpaths = ["tests"]
```
Set `requires-python` to the oldest version you truly support; check the current supported Python releases before choosing.

## 2. Style and idioms

- Follow PEP 8 naming (see `clean-code`), let Ruff format, and prefer clear code over clever code.
- Use **f-strings**, `pathlib.Path` (not `os.path`), `enumerate`, `zip(..., strict=True)`, comprehensions and generator expressions (keep them readable), `dict.get`/`setdefault`/`collections.defaultdict`/`Counter`, `itertools`, `functools`, `any`/`all`, unpacking, `match` statements for structural matching (3.10+).
- **Never use mutable default arguments** (`def f(x=[])`); use `None` and create inside, or `field(default_factory=list)`.
- Compare `is None`/`is not None`; use truthiness deliberately; avoid `== True`.
- Prefer EAFP (try/except) where natural, LBYL for cheap checks; keep `try` blocks narrow.
- Use `with` for resources (files, locks, connections, temporary directories); write context managers via `contextlib.contextmanager`.
- Avoid wildcard imports and circular imports; import order handled by Ruff; keep import-time side effects out of modules.
- Use `__all__` for library public APIs; underscore-prefix internals.
- Prefer composition and small functions; use classes when you have state plus behavior, dataclasses for data, `Protocol` for structural interfaces, `enum.Enum`/`StrEnum` for closed sets.
- Immutability where helpful: `@dataclass(frozen=True, slots=True)`, tuples, `frozenset`, `typing.Final`.

## 3. Typing

```python
from __future__ import annotations   # optional on 3.11-; postponed evaluation
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from typing import Literal, Protocol, TypedDict, Self

type UserId = str                       # PEP 695 syntax on 3.12+; NewType/TypeAlias earlier

@dataclass(frozen=True, slots=True)
class Order:
    id: str
    lines: tuple[Line, ...]
    status: Literal["draft", "paid", "shipped"] = "draft"

class Clock(Protocol):
    def now(self) -> datetime: ...

def total(lines: Iterable[Line]) -> Decimal: ...
def find(users: Mapping[UserId, User], uid: UserId) -> User | None: ...
```
- Use built-in generics (`list[int]`, `dict[str, int]`), `X | None`, `collections.abc` types for parameters (accept the broadest useful type: `Sequence`, `Mapping`, `Iterable`) and concrete types for returns.
- Annotate all public functions, dataclass fields, and class attributes; avoid `Any` (use `object`, generics, `TypeVar`, or `Protocol`); use `TypedDict`/`Pydantic` for JSON shapes; `Literal` and `enum` for choices; `@overload` for polymorphic signatures; `ParamSpec` for decorators.
- Handle `Optional` explicitly; do not silence the checker with blanket `# type: ignore`; if needed, use specific codes with a comment.
- Validate at boundaries with Pydantic (v2) or msgspec/attrs+cattrs; trust typed data internally.

## 4. Errors and resources

- Raise specific exceptions; define a small exception hierarchy per package (`class AppError(Exception)`); include context; chain with `raise NewError(...) from exc`.
- Never `except:` or bare `except Exception: pass`; catch what you can handle; log with `logger.exception` at the boundary where the error is finally handled.
- Use `finally`/context managers for cleanup; `ExceptionGroup` and `except*` for concurrent errors (3.11+).
- Use `assert` only for internal invariants (stripped with `-O`), not input validation.
- `Decimal` for money, `datetime` with time zones (`datetime.now(UTC)`, `zoneinfo`) and store UTC; never naive datetimes for instants.

## 5. Logging and configuration

```python
import logging
logger = logging.getLogger(__name__)      # module-level logger; no prints in libraries
logger.info("order_paid", extra={"order_id": order.id})
```
- Configure logging once at the application entry point (dictConfig or structlog/loguru with JSON output); libraries only create loggers.
- Use lazy formatting (`logger.info("x=%s", x)`) or structured fields; never log secrets.
- Configuration from environment via `pydantic-settings` (validate at startup, fail fast); no config in code; secrets from env or a secret manager; `.env` only for local development and excluded from git.

## 6. Concurrency

| Workload | Tool |
|---|---|
| Many concurrent I/O tasks (HTTP, DB, sockets) | `asyncio` |
| Blocking I/O in sync code | `ThreadPoolExecutor` |
| CPU-bound work | `ProcessPoolExecutor`, `multiprocessing`, native extensions (NumPy/Polars), or free-threaded/JIT builds where supported and tested |
| Distributed/background jobs | Celery, RQ, Dramatiq, arq, Temporal |

Asyncio rules:
- Never block the event loop (no `time.sleep`, blocking DB/HTTP clients, heavy CPU); use `await asyncio.to_thread(fn)` to offload.
- Use `asyncio.TaskGroup` (3.11+) for structured concurrency; `asyncio.timeout()` for deadlines; `asyncio.Semaphore` to bound concurrency; `asyncio.gather(..., return_exceptions=True)` only when you handle results explicitly.
- Always keep references to created tasks; handle cancellation (`except asyncio.CancelledError: cleanup; raise`).
- Use async-native libraries (`httpx.AsyncClient`, `asyncpg`, SQLAlchemy async, `aiofiles`); reuse clients and pools instead of creating per request.
- One `asyncio.run(main())` at the entry point.
- Threads share the GIL for CPU-bound Python code; protect shared mutable state with locks or queues.

## 7. Performance basics

- Measure first (`cProfile`, `py-spy`, `pyinstrument`, `scalene`, `timeit`); see `performance-optimization`.
- Wins: better algorithms and data structures (`set`/`dict` lookups, `deque`, `heapq`, `bisect`), avoid repeated work (`functools.cache`/`lru_cache` on pure functions), generators for streaming large data, `str.join` instead of `+=` in loops, local variable binding in hot loops, vectorization (NumPy/Pandas/Polars), `__slots__` for many small objects, `orjson` for JSON, `uvloop` for asyncio servers on Linux.
- Read files lazily; process in chunks; use `csv`/`pyarrow`/`polars` for big tabular data.

## 8. Testing

- pytest with fixtures, parametrization, `tmp_path`, `monkeypatch`, `caplog`, `capsys`; property tests with Hypothesis; coverage via `pytest-cov`; async tests via `pytest-asyncio` or `anyio`. Patterns: `testing-strategy/references/test-patterns.md`.
- Make code testable: inject dependencies (clock, HTTP client, repository), keep I/O at the edges, avoid global state and import-time side effects.

## 9. Frameworks and domains (short notes)

- **FastAPI**: Pydantic models for request/response; dependency injection (`Depends`) for DB sessions and auth; `async def` only with async I/O (otherwise plain `def` runs in a threadpool); response models to prevent data leaks; lifespan handlers for startup/shutdown; consistent error handlers returning problem+json; background work in a queue rather than `BackgroundTasks` for anything important; run with Uvicorn/Gunicorn workers behind a proxy.
- **Django**: fat models are fine, but keep business logic in services for complex flows; use `select_related`/`prefetch_related`; migrations reviewed; settings split by environment via env; use Django's security middleware defaults; DRF serializers for validation.
- **Flask**: application factory, blueprints, extensions initialized in factory, Pydantic or marshmallow for validation.
- **SQLAlchemy 2.x**: typed `Mapped[]` models, `select()` style, sessions per request/unit of work, Alembic migrations.
- **CLI**: Typer or Click; `argparse` for small scripts; return exit codes; support `--help`, `--verbose`, `--version`; log to stderr, results to stdout.
- **Data/ML**: notebooks for exploration, modules for logic; `pandas`/`polars`/`numpy`; `scikit-learn` pipelines; PyTorch with seeds, device handling, `torch.no_grad()` for inference, mixed precision, checkpointing; track experiments (MLflow/W&B); see `data-analysis` and `llm-application-engineering`.
- **Packaging/publishing**: build with `uv build` or `python -m build`, publish via trusted publishing (OIDC) to PyPI; semantic versioning; `py.typed` marker for typed libraries.

## 10. Security notes

- Never `eval`/`exec` untrusted input; avoid `pickle` and unsafe `yaml.load` (use `yaml.safe_load`); use `subprocess.run([...], check=True)` without `shell=True`; parameterized SQL; `secrets` module for tokens; `hashlib`/`hmac.compare_digest` for constant-time comparison; validate file paths; keep dependencies audited (`pip-audit`, `uv pip audit`/OSV) and pinned via lockfile. See `security-review`.

## 11. Review checklist

- [ ] Ruff, formatter, type checker, and tests pass
- [ ] No mutable defaults, bare excepts, or blocking calls in async code
- [ ] Public API typed and documented; boundaries validated
- [ ] Resources closed via context managers; timeouts on network calls
- [ ] Config from environment; no secrets in code; logging configured at entry point
- [ ] Time zones handled; money uses `Decimal`
- [ ] Dependencies declared in pyproject and locked
