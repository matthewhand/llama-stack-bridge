# Disposable runtime qualification (approval-gated)

This is the existing PR #1 verification workflow, not a deployment instruction.
It is **NOT RUN** merely because these files exist. Use synthetic fixture traffic
only. No hosted CI, production Docker daemon, existing networks, real Llama Stack,
real credentials or private prompts.

## Rootless network-isolated Alpine sandbox (non-Docker path)

For this PR #1 continuation, the existing extracted Alpine 3.22 x86-64
rootfs is exercised without Docker. The runner uses a rootless user namespace,
a separate network namespace with no default route, loopback-only synthetic
mock/bridge listeners, an immutable rootfs bind, UID/GID 100:101, and a tmpfs
`/tmp`. It runs the packaged Nginx/njs `--check` entrypoint and the complete
fictional HTTP matrix (40/40 checks, including exact 1 MiB fixed-length and
chunked boundaries, 1 MiB+ chunked rejection, and >10 MiB njs parser rejection).
This path does not build an OCI image, start a shared Docker daemon, connect to
a real Llama Stack server, or prove deployment behavior under Compose. Its
exact runner and evidence remain task-local.

Packaged njs 0.9.6 has a specific chunked-response behavior: its parser can
buffer up to ten times `max_response_body_size` before rejecting. The bridge
therefore enforces the exact 1 MiB accepted-body limit after `text()`, tests
both a 1 MiB+ chunked response and a >10 MiB chunked parser rejection, and
caps all active API requests globally at four. The resulting worst-case
chunked parser buffering is approximately 40 MiB plus bounded read buffers;
the Compose source declares a 256 MiB memory limit. Do not describe this as a
1 MiB hard memory cap.

## Gate 0 — dedicated VM and immutable inputs

Obtain separate approval for downloads/installation and container execution.
Before any Docker command, prove that the target is a disposable Linux VM with
its **own** Docker daemon, with adequate free disk and RAM, the expected
`docker context`, no shared production networks, and an ownership-verified
empty namespace. The previously evaluated shared host's root filesystem was 93% used on 15 October
2026; do not build there as a substitute for an approved disposable VM.

Select a unique `VERIFY_PROJECT`; preserve it in the evidence manifest.
Supply **real, preverified** digest references for `PYTHON_IMAGE_DIGEST`
(Python 3.12 Alpine) and `ALPINE_IMAGE_DIGEST` (Alpine 3.22).
Reject placeholders, mutable tags and a digest for a different platform.
Verify the actual image digest/OS/architecture independently from trusted
registries and the local image store. Record the package repository snapshot
and actual nginx, njs and gettext package versions/hashes; the Dockerfile
still installs Alpine packages from a mutable repository index, so digest
pinning of the base alone does not close provenance.

Do **not** use the repository's ordinary `docker-compose.yaml` or
its local `.env`. Only `tests/runtime.compose.yaml` may be selected.
Check ownership labels before and after execution, and separately check
firewall/daemon egress confinement. The Compose `internal: true` network
is a defense-in-depth declaration, **not proof of traffic isolation**.

## Gate 1 — source and offline verifier negative controls

Run on the approved checkout using existing interpreters; these do not
need Docker:

```sh
node --test tests/*.test.mjs
python3 -B -m unittest discover -s tests -p 'test_*.py' -v
python3 -B tests/verify_http.py --self-test
python3 -O tests/verify_http.py --self-test
python3 -B tests/verify_http.py --negative-control  # MUST exit 1
python3 -O tests/verify_http.py --negative-control   # MUST exit 1
sh -n nginx/entrypoint.sh
```

Never use shell commands that ignore an expected failure accidentally.
The Python negative controls must exit nonzero in ordinary and optimized
execution. An intentionally false test must never count as a PASS.

## Gate 2 — preflight before normal Nginx startup

Commands below are **examples only**; do not execute without the above
approvals, verified input digests and independent resource ownership:

```sh
export VERIFY_PROJECT='lsb-verify-UNIQUE-ID'
export PYTHON_IMAGE_DIGEST='python:3.12-alpine@sha256:APPROVED_DIGEST'
export ALPINE_IMAGE_DIGEST='alpine@sha256:APPROVED_DIGEST'
export APK_REPOSITORY='https://APPROVED_IMMUTABLE_PACKAGE_SNAPSHOT'
export NGINX_APK_VERSION='APPROVED_EXACT_PACKAGE_VERSION'
export NJS_APK_VERSION='APPROVED_EXACT_PACKAGE_VERSION'
export GETTEXT_APK_VERSION='APPROVED_EXACT_PACKAGE_VERSION'
docker context show
docker compose -f tests/runtime.compose.yaml config -q
docker image inspect "$PYTHON_IMAGE_DIGEST" "$ALPINE_IMAGE_DIGEST"
docker compose -f tests/runtime.compose.yaml build --pull=false bridge
docker compose -f tests/runtime.compose.yaml up -d mock
docker compose -f tests/runtime.compose.yaml run --rm --no-deps bridge --check
```

Capture full exit codes, image IDs/digests, build dependencies, package
versions and the `nginx -t` output. The `--check` mode runs validation
and exits without starting workers. A failure means **STOP**;
do not run normal bridge startup. Verify mock service is healthy, only
test-owned resources exist, and no automatic restarts occurred.

## Gate 3 — actual HTTP on the disposable VM

Only after successful Gate 2:

```sh
docker compose -f tests/runtime.compose.yaml up -d bridge
python3 -B tests/verify_http.py --evidence /tmp/lsb-http-evidence.json
docker compose -f tests/runtime.compose.yaml logs --no-color > /tmp/lsb-compose.log
python3 -B tests/verify_http.py --scan-only --log-file /tmp/lsb-compose.log
docker compose -f tests/runtime.compose.yaml ps -a
```

The verifier includes a deliberate 35-second idle upstream and a bounded
45-second client deadline for testing the Nginx 30-second read timeout.
A client-side timeout **fails** the test; this does not establish a hard
total request deadline. The verifier must also confirm njs secure random
availability (chat IDs) and parseable Nginx configuration before release.

The standalone mock CLI defaults to 127.0.0.1; only this disposable
Compose file explicitly binds it to 0.0.0.0 *inside the dedicated internal
container network*, with its published test port still loopback-only.
The Python verifier disables inherited HTTP proxy settings and rejects
redirects rather than following a server-selected destination.

The verifier connects **only** to numeric loopback ports 42070/42071,
uses fictional payloads, and compares full JSON translation, HTTP
status/error categories, numeric boundaries, Unicode, assistant history,
alias routes, upstream error classes, exact request counts, privacy
headers on both routes and size boundaries. It rejects client timeouts:
a client timeout is NOT evidence of upstream timeout handling.

Capture/scan all test-owned log surfaces, not just Compose output:
mock and bridge stdout/stderr, container/daemon events, Nginx error
log, and any additional approved VM test logs. Check for canaries
without copying private bodies to the report. Unprovided log sources
are **not** certified by the `--scan-only` option.

Inspect actual container UID/GID, dropped capabilities, privileges,
read-only mount, tmpfs sizes, limits, published bind IP, network
connectivity/egress, restart counts, OOM flags and nonzero exits.
Use a bounded network-denial probe and verify isolation independently.
Report test startup, test-only events and teardown; do not infer
containment solely from Compose source. Verify both AMD64/ARM64 only
if those platforms are in the intended release scope.

## Gate 4 — ownership-verified cleanup and evidence

Before cleanup, independently compare Compose project name,
`org.llama-stack-bridge.verification` and owner labels, container IDs,
network IDs, and test-created volumes against the initial manifest.
Never use global `docker system prune`, delete unrelated containers,
or delete an unverified volume/network. For confirmed test-owned
resources only, `docker compose -f tests/runtime.compose.yaml down -v`,
then independently re-list the daemon to prove removal. Check whether
a test-owned bridge image remains; remove only after image ownership
verification. Preserve a **sanitized** manifest containing digests,
checksums, test outcomes, entrypoint preflight, security inspections,
logs scanned and cleanup evidence, without prompts or credentials.

## Independent exact-diff review gate

No reviewer inference has been run or source transmitted. Amazon Q CLI is not
authenticated. Claude Code reports a first-party Max subscription, but its
local auth status does not establish the account's data-sharing/retention
settings or whether extra usage can incur charges. Subscription type alone
is insufficient; obtain positive verification of all three conditions and
an independent review of the exact candidate diff before any PR write.

## Pinned upstream compatibility and package provenance

## Scope

The bridge's source/package compatibility target is the 31 October 2024
Llama Stack API revision `37b330b4ef24a9253abba07cf906bf4ac3af6e55`, paired
with the versioned `llama-stack==0.0.47` and `llama-models==0.0.47`
Python distributions. This is a source/package-level target exercised by
synthetic HTTP fixtures. No live Llama Stack server, model weights, prompts,
or inference are used or qualified.

## Upstream source contract

The exact Llama Stack source commit declares `version="0.0.47"` in
`setup.py` (SHA-256 `b322300412dc5cb71a61d9d4a060f961308f890f1cc8635abde7e17a379553a6`)
and `llama-models>=0.0.47` in `requirements.txt` (SHA-256
`ad6df13ebff76b9cf7a6e5d7025c2cadf1c0fcf1fe67acfc73a0fee464b71b45`).
The upstream Git commit timestamp is `2024-10-31T21:46:25Z`.

- `llama_stack/apis/models/models.py` declares `GET /models/list` returning
  `List[ModelDefWithProvider]`; model records include `identifier` and
  `provider_id`.
- `llama_stack/apis/inference/inference.py` declares
  `POST /inference/chat_completion`; `ChatCompletionRequest` uses `model`,
  `messages`, optional `sampling_params`, and `stream` (default false).
- `llama_models/datatypes.py` defines `SamplingParams.strategy` with the
  default `greedy`; `max_tokens` is optional. The bridge therefore sends
  no sampling object when no limit is requested, or only `max_tokens` when
  supplied, allowing the upstream default strategy to apply.
- `llama_models/llama3/api/datatypes.py` defines
  `InterleavedTextMedia` as text, `ImageMedia`, or a list of text/image
  values. The bridge supports strings and lists of strings only; images
  fail closed. `CompletionMessage` contains `role`, `content`, `stop_reason`,
  and `tool_calls` (default empty list). The bridge accepts absent/empty
  tool calls and rejects nonempty tool calls.
- `ChatCompletionResponse` contains `completion_message` and optional
  `logprobs`; it does not define `usage`. Usage extensions are not part of
  the compatibility promise.

## Immutable package artifacts

Downloaded over HTTPS from `files.pythonhosted.org`; SHA-256 values matched
the corresponding PyPI JSON release metadata before the wheels were cached.

| Distribution | Wheel | SHA-256 | Bytes |
| --- | --- | --- | ---: |
| `llama-stack==0.0.47` | `llama_stack-0.0.47-py3-none-any.whl` | `1f7f10945736b21d42a24d6be1b425e5b6d3deb41395173fa350c04f2c674794` | 301,878 |
| `llama-models==0.0.47` | `llama_models-0.0.47-py3-none-any.whl` | `42775cf72c4915f2fbad148097757ceb4dc43ac5d27e31d286aa8ebf083bb1bc` | 1,570,065 |

Relevant extracted source hashes:

| Source | Reference | SHA-256 |
| --- | --- | --- |
| `llama_stack/apis/inference/inference.py` | Git commit `37b330b4ef24a9253abba07cf906bf4ac3af6e55` | `63e956cb874e24baaa9cc5356daf31d0c8d4e9aa34557d7869013e65a9237c46` |
| `llama_stack/apis/inference/inference.py` | 0.0.47 wheel | `f919479c025b51888c6e7f8df7ba89ab059dbc6f4dd887c76736c32c5b9d7a61` |
| `llama_stack/apis/models/models.py` | Git commit and 0.0.47 wheel | `8ece1262f558dcded50d03aa5268c234bf704331d892f0b0986a9cbaa5c371a2` |
| `llama_models/datatypes.py` | 0.0.47 wheel | `0256bd198c62a2266dc94205d5c0aa686220b6b173a44e3581189d3ff1921771` |
| `llama_models/llama3/api/datatypes.py` | 0.0.47 wheel | `4e41da38062559be979ea81b083f4a7cdeac028e274b33e2b246e7e9cbe9e971` |

The 0.0.47 wheel's inference module is not byte-identical to the historical
Git commit; this record does not claim a reproducible source build. Its
route and request/response schema declarations were independently inspected
and agree with the source-level contract above. The package and source
hashes are provenance evidence, not a cryptographic signature by Meta.

## Test coverage and limitations

The offline mock strictly validates the legacy routes, request field names,
optional sampling structure, assistant history shape, model-list shape and
completion response shape. The real-HTTP verifier checks the bridge against
that mock, including malformed and oversized fixed-length/chunked bodies,
Unicode byte boundaries, privacy headers, timeouts, concurrency and exact
upstream request counts.

No real upstream server or model is started. Passing these tests establishes
synthetic contract consistency, not live compatibility, model correctness,
performance, or production readiness.

## Stable-release limitations

Passing mock tests does **not** prove a live Llama Stack server is compatible.
The source/package contract is pinned to the 31 October 2024 source reference
(`37b330b4ef24a9253abba07cf906bf4ac3af6e55`) and the `llama-stack==0.0.47` /
`llama-models==0.0.47` wheel pair; see `UPSTREAM_COMPATIBILITY.md` for hashes
and schema details. The synthetic fixture validates the supported model-list
and text-only chat contract. Live server behavior, model correctness, and
production readiness remain unverified. No stable release, PR merge,
production deployment or GitHub release without explicit approval.
