# Llama Stack Bridge

**Maturity: experimental / release candidate work — NOT stable, beta-qualified, or production-ready.**

A small, local-first Nginx + njs adapter for a **limited legacy Meta Llama Stack API**. It translates model listings and **non-streaming, text-only** chat responses into OpenAI-style JSON. The implementation is not an official Meta/OpenAI integration and does not promise complete OpenAI API compatibility.

> This documentation describes the isolated `release-readiness/2026-10-13-doc-app` development branch. The published `main` branch remains the old 2024 prototype until explicitly reviewed and merged.

## Request flow

```mermaid
flowchart LR
    A[Local OpenAI-style client] -->|127.0.0.1:42070| B[Nginx + njs bridge]
    B -->|Legacy HTTP endpoint| C[Configured Llama Stack]
```

The public HTTP interface is loopback-bound by default. The bridge **has no authentication or TLS**. Keep it on a trusted local machine; do not change the port binding to `0.0.0.0` or expose it through a reverse proxy without a separately reviewed access-control design.

## Scope — what does and does not work

| Endpoint / capability | Source implementation | Qualification |
| --- | --- | --- |
| `GET /v1/models` (alias `/models`) | Maps legacy `GET /models/list` results to model-list JSON | Synthetic tests; live upstream unverified |
| `POST /v1/chat/completions` (alias `/chat/completions`) | Maps legacy `POST /inference/chat_completion` results to non-streaming text completions | Synthetic tests; live upstream unverified |
| `GET /healthz` | Reports Nginx service availability | Not proof the upstream is available |
| Invalid inputs, unsupported options | Returns structured 400 responses | Covered by mock-based tests |
| `stream: true` | Rejects with 501, not silently accepted | Not implemented |
| Tools/function calls, images, audio, JSON schema, multimodal messages, `/v1/responses` | Unsupported; no translation promised | Not implemented |
| Native OpenAI authentication, TLS, upstream bearer token forwarding | Unsupported | No internet/LAN deployment |

The adapter currently accepts a `model` string, nonempty `messages` of text-only `system`/`user`/`assistant` roles, plus optional `max_tokens`, `temperature`, `top_p`, `top_k` and `repeat_penalty`. Other fields fail closed instead of silently changing their meaning. It maps older Llama Stack `completion_message` response shapes and normalizes ordinary token usage. **Modern Llama Stack may use different routes or schemas.**

## Local quick start — after an approved container smoke test

**Prerequisites:** Docker Engine with Compose v2, an accessible legacy Llama Stack HTTP server, and a trusted local development environment. An upstream bound only to the Docker host's `127.0.0.1` may **not** be reachable via `host.docker.internal` inside the container; arrange a safely accessible Docker-network endpoint rather than exposing the upstream to the internet.

1. Clone this repository and switch to the isolated review branch (until its changes are merged):

   ```sh
   git clone https://github.com/matthewhand/llama-stack-bridge.git
   cd llama-stack-bridge
   git switch release-readiness/2026-10-13-doc-app
   cp .env.sample .env
   ```

2. Set `UPSTREAM_HOST` and `UPSTREAM_PORT` in `.env`. Host accepts a DNS name or IPv4 address; port must be between 1 and 65535. Do not include `http://`, URL paths, or credentials. The sample uses `host.docker.internal:42069`, which only works when a suitable Docker host gateway is reachable.

3. Once the operator approves a disposable build, run:

   ```sh
   docker compose build
   docker compose up -d
   curl -fsS http://127.0.0.1:42070/healthz
   curl -fsS http://127.0.0.1:42070/v1/models
   ```

   `/healthz` confirms only that Nginx responds. For an actual chat test, select a real model identifier returned by the upstream:

   ```sh
   curl -fsS http://127.0.0.1:42070/v1/chat/completions \
     -H 'Content-Type: application/json' \
     -d '{"model":"REPLACE_WITH_MODEL_ID","messages":[{"role":"user","content":"Synthetic hello"}]}'
   ```

4. Inspect results without using private prompts. Stop the isolated environment when finished with `docker compose down`. Do not run this example against production endpoints without independent security and compatibility reviews.

The Compose service runs unprivileged, drops Linux capabilities, uses a read-only filesystem with a bounded temporary directory, disables Nginx access logging, and binds only `127.0.0.1:42070` on the host. These are **source-level controls, not a substitute for a completed runtime security test**.

## Local tests (no hosted CI)

Node.js 20+ is required **only for the test harness**, not inside the Nginx container. There are no npm dependencies to install.

```sh
node --test tests/transform.test.mjs
```

The synthetic suite exercises successful legacy transformations, model listings, numeric defaults, rejected streaming and tool options, malformed inputs, unsupported message types, generic upstream errors, missing upstream responses and sensitive-log regression checks. **17 synthetic test cases passed in an isolated V8 evaluation on 13 October 2026; a clean Node runner, real njs, image build and upstream integration have not yet been independently validated.**

No GitHub Actions workflow is supplied or needed. Do not enable hosted CI on private repositories.

## Important limitations

- **Upstream dependency:** this translation targets an older Llama Stack API, not contemporary universal OpenAI API compatibility.
- **Security:** no endpoint authentication, no HTTPS, and no support for an authenticated upstream. Default bind is loopback only; even locally, another process may call this bridge.
- **Content:** text-only chat. Streaming, tools and nontext message content are intentionally rejected.
- **Resource limits:** the Nginx config caps request body size at 64 KiB and buffered subrequest responses at 1 MiB; long histories and large replies can fail.
- **Error behavior:** invalid user requests return HTTP 400; unsupported streaming returns 501; upstream failures or malformed upstream responses return generic 502 without returning upstream bodies to clients.
- **Build reproducibility:** Alpine is pinned to its minor series, not an immutable image digest or package hash. Fresh-build proof and a dependency vulnerability assessment are still required.
- **Releases:** no verified live Llama Stack version matrix, independent load test or production incident runbook exists.

## Release acceptance gates

- [x] Separate original prototype claims from demonstrated functionality.
- [x] Add fail-closed synthetic API checks and remove conversation-body debug logging in source.
- [x] Add rootless, loopback-only Compose configuration and explicit validated upstream substitution in source.
- [ ] Independently run the Node 20+ suite and inspect the exact test results.
- [ ] Independently build the image and run `nginx -t` from a clean checkout on target architectures.
- [ ] Exercise `/healthz`, models and chat with a **synthetic, local** mock upstream over real HTTP.
- [ ] Pin and verify one explicitly supported legacy Llama Stack version, and document contemporary upstream incompatibilities.
- [ ] Prove default host-binding, UID, mounts, memory behavior and absence of sensitive data in logs.
- [ ] Review malformed bodies, upstream resets/timeouts, high concurrency, startup shutdown and supported platform coverage.
- [ ] Independently audit threat model, dependency provenance, deployment documentation, and versioned release artifacts.
- [ ] Assign a stable version **only after** all scoped gates pass; unsupported advanced features need not be added, but must remain explicit.

## Project files

- `nginx/transform.js` — njs API transformation handlers.
- `nginx/nginx.conf` — environment-substituted Nginx config template.
- `nginx/entrypoint.sh` — strict upstream configuration validation and local Nginx test.
- `nginx/Dockerfile` — packaged Alpine Nginx/njs, unprivileged runtime.
- `docker-compose.yaml` — loopback-only and resource-constrained deployment.
- `tests/transform.test.mjs` — dependency-free synthetic regressions.

## License

MIT — see [LICENSE](LICENSE).
