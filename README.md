# Llama Stack Bridge

**Status: experimental legacy prototype — not production-ready.**

Llama Stack Bridge is a small Nginx + njs adapter intended to expose selected OpenAI-style REST endpoints backed by an older Meta Llama Stack API. This project is not an OpenAI API implementation or an official Meta/OpenAI integration.

> **Release safety note (2026-10-13):** The original source has not been validated against a contemporary Llama Stack release, and its Nginx configuration, build chain, logging and network defaults require correction. Do not expose it to the internet, or send private conversations through an unreviewed deployment.

## What exists in the original code

| Capability | Original source status |
| --- | --- |
| Model listing | JavaScript adapter for legacy `/models/list`; unverified with current upstream |
| Chat completions | Non-streaming conversion from `/inference/chat_completion`; unverified |
| Docker Compose | Recipe present; fresh installation not demonstrated |
| Streaming, tools, multimodal inputs | Not implemented |
| OpenAI SDK route compatibility | Incomplete: paths lack the common `/v1` prefix |
| Automated regression suite | Not present |
| Privacy and network security | Unsafe original defaults; must be repaired |

The implementation targets legacy Llama Stack response shapes (including `completion_message`). Modern Llama Stack APIs can differ. **Never infer compatibility with current upstream versions from the repository name alone.**

## Read this before attempting a deployment

The original Compose recipe publishes TCP 42070 on all host interfaces, and the original njs code logs entire request and response bodies. The original Dockerfile also retrieves old code without reproducible artifact verification. These are blockers for any shared or sensitive deployment.

Until these are corrected and independently verified, use this repository **only for source review**, not production traffic. There is no established supported version matrix.

## Planned safe, local verification

The next implementation pass will establish a loopback-only default, remove content logging, make startup configuration explicit, and add dependency-free synthetic tests. Documentation will be updated *after* those changes land on the review branch. No hosted GitHub CI is required or requested.

## Release gates

- [ ] Confirm Nginx module loading and configuration with a clean isolated container build.
- [ ] Verify model list and non-streaming chat using synthetic local upstream fixtures.
- [ ] Confirm malformed requests, unsupported features, timeouts and upstream failures fail safely.
- [ ] Prove no sensitive content in application logs and default loopback-only binding.
- [ ] Test representative pinned legacy upstream and at least one explicitly selected current upstream, or limit the published compatibility claim accordingly.
- [ ] Run independent compatibility, security, and resource reviews before a production-ready claim.

## License

MIT — see [LICENSE](LICENSE).
