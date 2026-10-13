# Security and privacy boundaries

**Current status: experimental. Do not expose this bridge to the internet or put production or private prompts through it without a separate security review.**

## Trust boundary

This bridge accepts unauthenticated HTTP from local clients and connects to an upstream HTTP Llama Stack service. The upstream endpoint is chosen by the local operator in `.env`. The bridge does **not** provide HTTPS, API-key verification, upstream authentication, tenant separation, user isolation, or audit-grade access controls.

The Compose port mapping defaults to `127.0.0.1:42070:8080`. This protects against direct external network reachability but **does not protect against untrusted processes on the same host**, container-network peers, hostile local extensions, or another local process that can reach the socket. Do not rebind to `0.0.0.0` without a reviewed authentication and network-isolation layer.

## What the review-branch source does

- Runs Nginx as an unprivileged Linux user, on port 8080 inside the container.
- Drops Linux capabilities, blocks privilege escalation, mounts the root filesystem read-only and uses a bounded temporary filesystem.
- Validates the configured upstream DNS name/IPv4 address and TCP port before rendering the server config.
- Disables Nginx access logging and avoids logging prompt and response bodies from njs handlers.
- Drops incoming request headers on internal upstream proxy locations. This means that **client Authorization headers are intentionally not forwarded**; private upstreams requiring credentials are not supported.
- Limits request bodies to 64 KiB and buffered subrequest results to 1 MiB.
- Maps upstream errors to generic 502 JSON rather than reflecting private upstream bodies.

These controls are visible in source but have **not** been validated in a live container or against a security scanner.

## Unresolved risks / release gates

- No endpoint authentication or TLS. Only use within a controlled local environment.
- Upstream traffic is HTTP and may cross local networks. Do not assume encryption, integrity or confidentiality in transit.
- Alpine dependencies are not pinned to image digests and exact package checksums.
- The Nginx/njs image has not been independently built; module availability, filesystem permissions and runtime behavior remain unverified.
- No denial-of-service, resource exhaustion, concurrency or malformed-protocol fuzz testing has been performed.
- There is no pinned, verified Llama Stack upstream version or support policy.
- Even with access logging disabled, other infrastructure (host, reverse proxy, Docker, upstream) may still log prompts or credentials.

Until independent tests close the above gaps, do not describe this as safe for sensitive or production workloads.

## Review principle

Use synthetic-only prompts for tests. Do not store credentials in this repository or open issues. When reporting a vulnerability, avoid publishing secret values or private request bodies; include a minimal synthetic reproduction.
