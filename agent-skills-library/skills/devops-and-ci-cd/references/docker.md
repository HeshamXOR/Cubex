# Docker reference

## Contents
1. Dockerfile principles
2. Multi-stage examples
3. .dockerignore
4. Runtime hardening
5. Image supply chain
6. Docker Compose for local dev
7. Debugging containers
8. Checklist

## 1. Dockerfile principles
- Small, specific base images: `python:3.12-slim`, `node:22-alpine` (note musl differences for some native modules), `distroless` or `chainguard` images for runtime. Pin to a version and, for production, a digest (`image@sha256:...`).
- **Multi-stage builds**: build tools and compilers in a builder stage; copy only artifacts into the runtime stage.
- **Layer order for cache efficiency**: copy dependency manifests first, install, then copy source.
- Combine related `RUN` commands and clean package caches in the same layer (`apt-get update && apt-get install -y --no-install-recommends ... && rm -rf /var/lib/apt/lists/*`).
- Use BuildKit features: cache mounts (`RUN --mount=type=cache,target=/root/.cache/pip ...`), secret mounts (`RUN --mount=type=secret,id=npmrc ...`) so secrets never land in layers.
- Run as a **non-root** user; set `WORKDIR`; use `COPY` (not `ADD`) unless extracting archives; use exec form for `CMD`/`ENTRYPOINT` (`["python", "-m", "app"]`) so signals reach the process.
- One process per container; log to stdout/stderr; handle `SIGTERM`; add `HEALTHCHECK` or use orchestrator probes.
- Set `ENV PYTHONUNBUFFERED=1`, `PYTHONDONTWRITEBYTECODE=1`, `NODE_ENV=production` as appropriate.
- Never bake secrets, `.env` files, SSH keys, or `.git` into images.

## 2. Multi-stage examples
Python with uv:
```dockerfile
# syntax=docker/dockerfile:1
FROM python:3.12-slim AS builder
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv
WORKDIR /app
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy
COPY pyproject.toml uv.lock ./
RUN --mount=type=cache,target=/root/.cache/uv uv sync --frozen --no-install-project --no-dev
COPY src ./src
RUN --mount=type=cache,target=/root/.cache/uv uv sync --frozen --no-dev

FROM python:3.12-slim AS runtime
RUN useradd --create-home --uid 10001 app
WORKDIR /app
COPY --from=builder --chown=app:app /app /app
ENV PATH="/app/.venv/bin:$PATH" PYTHONUNBUFFERED=1
USER app
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=3s CMD python -c "import urllib.request;urllib.request.urlopen('http://127.0.0.1:8000/healthz')"
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
```
Node:
```dockerfile
# syntax=docker/dockerfile:1
FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci

FROM deps AS build
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/package.json ./
USER node
EXPOSE 3000
CMD ["node", "dist/server.js"]
```
Go (static binary):
```dockerfile
FROM golang:1.23 AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/app ./cmd/app

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/app /app
ENTRYPOINT ["/app"]
```
Check the current supported language and base image versions when writing real files.

## 3. .dockerignore
```
.git
.gitignore
node_modules
**/__pycache__
.venv
.env*
*.log
dist
coverage
Dockerfile*
docker-compose*.yml
.idea
.vscode
```
Keeps the build context small and prevents leaking secrets.

## 4. Runtime hardening
- Run with `--read-only` root FS plus `tmpfs` for scratch, `--cap-drop=ALL` (add back only what is needed), `--security-opt=no-new-privileges`, non-root `--user`, resource limits (`--memory`, `--cpus`, `--pids-limit`).
- Do not mount the Docker socket into containers. Avoid `--privileged` and host networking unless essential.
- Use user namespaces or rootless Docker/Podman where feasible.
- Restrict egress with network policies or firewalls; use internal networks for databases.
- Keep images patched: rebuild regularly to pick up base image fixes; scan in CI.

## 5. Image supply chain
- Scan with Trivy, Grype, or Docker Scout; fail builds on fixable high/critical CVEs.
- Generate an SBOM (`syft`, `docker buildx --sbom`), attach provenance (`--provenance`), and sign with cosign; verify signatures in admission control (Kyverno, Sigstore policy-controller).
- Tag images with the git SHA (immutable) and release version; avoid deploying `latest`. Deploy by digest.
- Use a private registry or pull-through cache; restrict who can push.

## 6. Docker Compose for local dev
```yaml
services:
  api:
    build: .
    ports: ["8000:8000"]
    environment:
      DATABASE_URL: postgresql://app:app@db:5432/app
    depends_on:
      db: { condition: service_healthy }
    develop:
      watch:
        - action: sync
          path: ./src
          target: /app/src
  db:
    image: postgres:16
    environment: { POSTGRES_USER: app, POSTGRES_PASSWORD: app, POSTGRES_DB: app }
    volumes: [pgdata:/var/lib/postgresql/data]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U app"]
      interval: 5s
      retries: 10
volumes: { pgdata: {} }
```
Compose is for local development and simple single-host deployments; use `docker compose up --build`, `docker compose logs -f api`, and `docker compose down -v` to reset state. Keep production configuration separate (override files or an orchestrator).

## 7. Debugging containers
```bash
docker ps -a; docker logs -f --tail 200 <c>
docker exec -it <c> sh                  # inspect a running container
docker run --rm -it --entrypoint sh <image>   # inspect an image
docker inspect <c> | jq '.[0].State'    # exit code, OOMKilled
docker stats; docker history <image>    # resource use; layer sizes
docker buildx build --progress=plain .  # full build output
docker run --rm -v "$PWD":/w -w /w hadolint/hadolint hadolint Dockerfile
```
Common failures: exit code 137 (OOM or SIGKILL), 143 (SIGTERM), wrong architecture (`--platform linux/amd64` vs arm64), file permission mismatches after switching to non-root, missing shared libraries on Alpine/distroless, PID 1 not forwarding signals (use `tini` or `--init`), DNS or proxy in build.

## 8. Checklist
- [ ] Multi-stage; final image contains only runtime needs
- [ ] Non-root user; exec-form CMD; SIGTERM handled
- [ ] Dependencies installed from lockfile before source copy
- [ ] No secrets in layers, args, or environment baked at build time
- [ ] `.dockerignore` present; image scanned; SBOM and signature produced
- [ ] Healthcheck or probes defined; resource limits set at runtime
- [ ] Base image and dependency versions pinned and updated regularly
