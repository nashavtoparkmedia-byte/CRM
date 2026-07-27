# Security gates

Registry publication is ordered after all gates:

1. Exact lockfile audits for gateway source/runtime and scraper source/runtime report zero findings.
2. Syft emits non-empty SPDX JSON and CycloneDX JSON from each exact built image; source commit, build timestamp, architecture, base digest, image ID and configured user are injected and validated as machine-readable provenance.
3. Grype reports zero runtime Critical and zero fixable runtime High.
4. Trivy reports zero runtime Critical, zero fixable runtime High and zero image secrets.
5. Any remaining unfixed High writes a complete `SECURITY_ACCEPTANCE_REQUIRED.json` and stops before registry publication; Codex cannot accept it.
6. Gateway executes as exact UID/GID 1000:1000 and scraper as exact UID/GID 1001:1001.
7. Dormant, invalid-config, active synthetic, durable outage/restart and pull-by-digest proofs pass.
8. Immutable GHCR tags are created once. A retry may reuse a partially published tag only when its remote config digest exactly equals the rebuilt image ID; a mismatch fails closed and is never overwritten.

The final runtime stages deliberately omit the base images' global npm CLI and root npm cache; the application lock-installed production modules remain under `/app/node_modules`, and migrations invoke the pinned application Prisma binary directly. Gateway OpenSSL is pinned to Alpine `3.5.7-r0`. The Chromium-only scraper removes unused Firefox/WebKit payloads and the two unfixed vulnerable GStreamer bad-plugin packages, then proves a Chromium executable remains. Because the pinned Playwright base contained SAS-shaped npm-cache data in a lower OCI layer, the sanitized scraper root filesystem is copied into a fresh `scratch` final stage; the workflow limits the resulting BuildKit rootfs to at most three sanitized-only layers and repeats the zero-secret scan. No advisory or secret path is suppressed.

Syft, Grype and Trivy archives are pinned by committed SHA-256 values. Downloaded scanner processes run without `GHCR_TOKEN` in their environment. The full final-image forensic inventories every scanner LOW/MODERATE/HIGH/CRITICAL result and retains the raw reports.

Old Stage 8B1 images fail these gates and are explicitly rejected. Scanner errors, missing databases, incomplete SBOMs or ambiguous severity/fix state fail closed.
