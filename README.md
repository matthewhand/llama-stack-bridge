# Llama Stack Bridge

**Maturity: experimental — release hardening in progress. NOT stable, beta-qualified, or production-ready.**

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

The adapter currently accepts a `model` string, nonempty `messages` of text-only `system`/`user`/`assistant` roles, plus optional `max_tokens` (nested under legacy `sampling_params`). Sampling strategy controls such as `temperature`, `top_p`, `top_k` and `repeat_penalty` are now rejected rather than falsely forwarded as flat fields. Other fields fail closed instead of silently changing their meaning. It maps the pinned legacy `completion_message` response shape. The pinned upstream response schema has no `usage` field; optional usage-shaped extensions are not part of the compatibility guarantee. **Modern Llama Stack may use different routes or schemas.**

**Legacy source contract:** On 15 October 2026, source inspection pinned a
historical [Llama Stack inference API revision](https://github.com/meta-llama/llama-stack/blob/37b330b4ef24a9253abba07cf906bf4ac3af6e55/llama_stack/apis/inference/inference.py)
(31 October 2024) and its [model-list API](https://github.com/meta-llama/llama-stack/blob/37b330b4ef24a9253abba07cf906bf4ac3af6e55/llama_stack/apis/models/models.py).
That revision's `setup.py` declares `llama-stack` version `0.0.47` and
its `requirements.txt` requires `llama-models>=0.0.47`. The exact PyPI
`llama-stack==0.0.47` and `llama-models==0.0.47` wheels were downloaded
from files.pythonhosted.org and their SHA-256 values checked against the
PyPI JSON release metadata. The package route/schema declarations agree
with the source reference: `/inference/chat_completion`, `/models/list`,
`model`, and optional `sampling_params` (greedy by default). The bridge
maps `max_tokens` into that nested structure, supports text-only
`InterleavedTextMedia`, and rejects nonempty completion tool calls.
See [the pinned upstream compatibility/provenance record](tests/VERIFICATION.md#pinned-upstream-compatibility-and-package-provenance).
**This is a source/package-level compatibility target with synthetic
HTTP coverage, not a live upstream integration or inference test.**

## Developer quick start — isolated experiments only

**Prerequisites:** Docker Engine with Compose v2, an accessible legacy Llama Stack HTTP server, and a trusted local development environment. An upstream bound only to the Docker host's `127.0.0.1` may **not** be reachable via `host.docker.internal` inside the container; arrange a safely accessible Docker-network endpoint rather than exposing the upstream to the internet.

1. Clone this repository and switch to the isolated review branch (until its changes are merged):

   ```sh
   git clone https://github.com/matthewhand/llama-stack-bridge.git
   cd llama-stack-bridge
   git switch release-readiness/2026-10-13-doc-app
   cp .env.sample .env
   ```

2. Set `UPSTREAM_HOST` and `UPSTREAM_PORT` in `.env`. Host accepts structurally valid DNS labels or canonical dotted-decimal IPv4; port must be between 1 and 65535. Do not include `http://`, URL paths, or credentials. The sample uses `host.docker.internal:42069`, which only works when a suitable Docker host gateway is reachable.

3. **Builds now fail closed without independently approved provenance inputs.** Before any separately authorised disposable build, export `ALPINE_IMAGE_DIGEST` (verified platform-correct `alpine@sha256:…`), `APK_REPOSITORY` (verified immutable HTTPS snapshot, not a mutable mirror), and exact `NGINX_APK_VERSION`, `NJS_APK_VERSION`, and `GETTEXT_APK_VERSION`. Record checksums and versions of all transitive installed packages. No digests, package versions or snapshot URLs are assumed in this repository. Only after approving these inputs and a disposable build, run:

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
node --test tests/*.test.mjs
python3 -B -m unittest discover -s tests -p 'test_*.py' -v
python3 -B tests/verify_http.py --self-test
python3 -O tests/verify_http.py --self-test
```

On 15 October 2026, the original **23 JavaScript tests passed 23/23 under
actual Node.js v22.22.3 on the Linux test host** (18 translation checks and five
source/deployment checks). The new **eight Python offline harness tests
passed 8/8**, including mock HTTP observations, exact wrong-payload and
leaked-header detection, and both ordinary and optimized-Python
negative controls. These tests use fictional data. This is **not**
evidence of a running Nginx container or a compatible live Llama
Stack server. No containers have been built or executed.

On 28–29 October 2026, a separate, private, offline source-remediation
worktree passed 31/31 Node and 9/9 Python checks, including strict hostname
input cases, unknown stop reasons, njs-compatible secure-ID format and
UTF-8 byte-bounded synthetic responses. Four deliberately faulty source
variants were rejected by the regression tests.
Neither the packaged njs cryptographic API nor the changed Nginx buffering
directives have yet been exercised in a real container. This work is not
merged into the public PR branch.

No GitHub Actions workflow is supplied. Do not enable hosted CI or spend
external build/inference resources without separate maintainer approval.

### Runtime qualification

The existing Docker/Compose qualification procedure remains separately
approval-gated and has not been executed. This PR continuation instead uses
the pre-existing rootless, network-isolated Alpine NGINX/njs sandbox; details
and its limitations are recorded in [tests/VERIFICATION.md](tests/VERIFICATION.md).
See that file for the **existing, approval-gated Docker runtime procedure** and its three files:
`mock_upstream.py`, `verify_http.py` and `runtime.compose.yaml`.
A dedicated disposable Linux VM, a distinct Docker daemon, adequate
headroom, verified immutable base-image/Python-image digests, explicit
permission for downloads/builds and separate permission for container
execution are required **before** use. The fixture must not connect to
production or handle real prompts. The bridge entrypoint now supports
`--check` to run the same configuration validation and `nginx -t` in
a one-shot container **before starting regular Nginx workers**.

The disposable Compose file uses a project-specific namespace and
ownership labels. These do not by themselves establish network
isolation, provenance, absence of leaks or complete cleanup. Independent
runtime inspection remains mandatory.

## Important limitations

See [SECURITY.md](SECURITY.md) for the full trust-boundary and privacy review.

- **Upstream dependency:** this translation targets an older Llama Stack API, not contemporary universal OpenAI API compatibility.
- **Security:** no endpoint authentication, no HTTPS, and no support for an authenticated upstream. Default bind is loopback only; even locally, another process may call this bridge.
- **Content:** text-only chat. Streaming, tools and nontext message content are intentionally rejected.
- **Resource limits:** request bodies are capped at 64 KiB. The NJS Fetch API enforces a 1 MiB `Content-Length` cap; packaged njs 0.9.6 can buffer chunked responses up to 10 MiB before rejecting, so a post-read UTF-8 byte guard enforces the exact 1 MiB accepted-body limit. A global four-request cap bounds worst-case concurrent chunked buffering to approximately 40 MiB plus read buffers; Compose declares a 256 MiB memory limit. The 30-second upstream timeout is an **idle I/O timeout, not a hard total request deadline**.
- **Error behavior:** invalid user requests return HTTP 400; unsupported streaming returns 501; upstream failures, malformed upstream responses and unknown completion stop reasons return generic 502 without returning upstream bodies to clients. Successful completion IDs require `crypto.getRandomValues` with documented `Uint32Array` input in the packaged njs runtime; the rootless sandbox proves this API is available in the tested package. Live upstream availability remains unverified.
- **Build reproducibility:** neither a mutable Alpine base tag nor unversioned package installation is provided by default. Build inputs now require a verified image digest, HTTPS package repository snapshot and explicit package versions. The actual snapshot immutability, transitive checksums and resulting image reproducibility have **not** been independently proven. Fresh-build proof and a dependency vulnerability assessment remain required.
- **Releases:** no verified live Llama Stack version matrix, independent load test or production incident runbook exists.

## Release acceptance gates

- [x] Separate original prototype claims from demonstrated functionality.
- [x] Add fail-closed synthetic API checks and remove conversation-body debug logging in source.
- [x] Add rootless, loopback-only Compose configuration and explicit validated upstream substitution in source.
- [x] Run the offline suites: 39/39 Node tests on Node v26.12.1; 11/11 Python tests on Python 3.10.12; verifier false-PASS controls fail under normal and optimized execution.
- [ ] Independently build the OCI image and run `nginx -t` from a clean checkout on target architectures (Docker/Compose intentionally not run).
- [x] Exercise `/healthz`, models and chat with a **synthetic, local** mock upstream over real HTTP: 40/40 checks in the rootless, network-isolated Alpine 3.22 x86-64 sandbox; no live Llama Stack.
- [x] Pin the source/package API contract to `llama-stack==0.0.47` and `llama-models==0.0.47`; document contemporary upstream incompatibilities. (Source/package and synthetic proof only; no live integration.)
- [x] Prove rootless sandbox UID/GID 100:101, read-only root, tmpfs `/tmp`, no default route, clean startup/shutdown, and canary-free Nginx/mock logs. Compose loopback binding and 256 MiB memory limit are source-checked, not runtime-proven.
- [x] Verify idle upstream timeout, fixed-length and chunked response limits (including exact 1 MiB boundaries and njs 10 MiB chunked rejection), `crypto.getRandomValues`, four-request global concurrency, and startup/shutdown over real HTTP on x86-64. ARM64 and Docker/Compose runtime behavior remain unverified.
- [ ] Obtain a genuine independent exact-diff security/privacy ACCEPT; no reviewer channel currently has positively verified private-source protection, retention and no-unexpected-metered-cost conditions, so no review inference was run.
- [ ] Assign a stable version **only after** all scoped gates pass; unsupported advanced features need not be added, but must remain explicit.

## Project files

- `nginx/transform.js` — njs API transformation handlers.
- `nginx/nginx.conf` — environment-substituted Nginx config template.
- `nginx/entrypoint.sh` — strict upstream configuration validation and local Nginx test.
- `nginx/Dockerfile` — packaged Alpine Nginx/njs, unprivileged runtime.
- `docker-compose.yaml` — loopback-only and resource-constrained deployment.
- `tests/transform.test.mjs` and `tests/source-contract.test.mjs` — Node synthetic and source regressions.
- `tests/mock_upstream.py`, `tests/verify_http.py`, `tests/test_harness.py`, and `tests/runtime.compose.yaml` — offline mock, real-HTTP verifier, fail-closed checks and disposable verification configuration.

- `tests/VERIFICATION.md` — explicit runtime approval gates, evidence and cleanup requirements.

## License

MIT — see [LICENSE](LICENSE).
