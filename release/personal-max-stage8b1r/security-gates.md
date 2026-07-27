# Security gates

Registry publication is ordered after all gates:

1. Exact lockfile audits for gateway source/runtime and scraper source/runtime report zero findings.
2. Syft emits non-empty SPDX JSON and CycloneDX JSON from each exact built image; source commit, build timestamp, architecture, base digest, image ID and configured user are injected and validated as machine-readable provenance.
3. Grype reports zero runtime Critical and zero fixable runtime High.
4. Trivy reports zero runtime Critical, zero fixable runtime High and zero image secrets.
5. Any remaining unfixed High writes a complete `SECURITY_ACCEPTANCE_REQUIRED.json` and stops before registry publication; Codex cannot accept it.
6. Gateway and scraper execute as exact UID/GID 1000:1000.
7. Dormant, invalid-config, active synthetic, durable outage/restart and pull-by-digest proofs pass.
8. Immutable GHCR tags are created once. A retry may reuse a partially published tag only when its remote config digest exactly equals the rebuilt image ID; a mismatch fails closed and is never overwritten.

Syft, Grype and Trivy archives are pinned by committed SHA-256 values. Downloaded scanner processes run without `GHCR_TOKEN` in their environment. The full final-image forensic inventories every scanner LOW/MODERATE/HIGH/CRITICAL result and retains the raw reports.

Old Stage 8B1 images fail these gates and are explicitly rejected. Scanner errors, missing databases, incomplete SBOMs or ambiguous severity/fix state fail closed.
