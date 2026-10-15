# Disposable runtime qualification (approval-gated)

This is the existing PR #1 verification workflow, not a deployment instruction.
It is **NOT RUN** merely because these files exist. Use synthetic fixture traffic
only. No hosted CI, production Docker daemon, existing networks, real Llama Stack,
real credentials or private prompts.

## Gate 0 — dedicated VM and immutable inputs

Obtain separate approval for downloads/installation and container execution.
Before any Docker command, prove that the target is a disposable Linux VM with
its **own** Docker daemon, with adequate free disk and RAM, the expected
`docker context`, no shared production networks, and an ownership-verified
empty namespace. Ubuntu-GTX's root filesystem was 93% used on 15 October
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

## Stable-release limitations

Passing mock tests does **not** prove real Llama Stack compatibility.
The 31 October 2024 source-only schema reference (`37b330b4ef24a9253abba07cf906bf4ac3af6e55`) is not a deployable compatibility qualification. Separately pin an explicit legacy upstream release/commit and validate
the supported model-list/chat contract against it on an approved
isolated environment. Record failure and security behavior, independent
acceptance and a reproducible installation. No stable release, PR
merge, production deployment or GitHub release without explicit approval.
