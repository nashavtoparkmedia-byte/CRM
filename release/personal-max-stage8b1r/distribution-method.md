# Authoritative distribution method: GHCR by digest

Only Option A is authoritative. The workflow publishes under the exact approved owner after all executable and security gates pass:

- `ghcr.io/nashavtoparkmedia-byte/crm-max-personal-gateway:stage8b1r-20260727t212144z`
- `ghcr.io/nashavtoparkmedia-byte/crm-max-web-scraper:stage8b1r-20260727t212144z`

The workflow refuses to overwrite either tag, records the registry digest and local image ID, removes each local tag, pulls by digest, and requires the pulled image ID to equal the built image ID. If an earlier attempt published only one image, a retry may reuse that tag only when its remote config digest exactly equals the rebuilt local image ID; every mismatch fails closed. It creates no `latest` tag. Authentication is the GitHub-hosted runner's repository-scoped `GITHUB_TOKEN` with `packages: write`; no production or repository-defined secret is used.

Stage 8B2 may consume only the two `repository@sha256:...` values in `final-image-manifest.json`. A tag alone is not an approved deployment identity. If the workflow cannot publish and verify both refs, distribution is blocked; the old local Stage 8B1 OCI layouts are forensic inputs, not deployable Stage 8B1R artifacts.

Any later root consumer must obtain owner-approved read access to those exact GHCR packages before the isolated probe. No credential value belongs in this package, its command line or its output; an unauthorized pull must fail closed. Registry read access does not authorize deployment.
