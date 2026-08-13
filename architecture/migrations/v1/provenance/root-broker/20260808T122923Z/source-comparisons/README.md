# CRM-ARCH-000R source comparison

This comparison is read-only and derives from the v1 runtime artifact captured at
`/opt/codex-work/crm-arch-000r-closure/20260808T120034Z/runtime-content-manifest.json`
(SHA-256 `e4cf904efafd89e5c63715e67fe7b588381556201ba9079ecc8370e84546d0ba`).
The FreeSWITCH portion is quarantined because v1 hashed secret-bearing configuration.
All v1 origin values are `image_or_writable_unknown`; they cannot close immutable-image
provenance.

## Accepted content-equivalence rows

- MAX scraper: 56 application files, all exact to current `/opt/crm/max-web-scraper`.
  Composition: 30 from `e6a0a833...`, 11 from `f97532cb...`, three from
  `74657f827...`, and 12 explicit production-working-tree files. Three post-start
  state files are excluded from the sanitized derivative.
- Telegram bot: 43/43 application files exact to current `/opt/crm/tg-bot`.
  Composition: 24 from `e6a0a833...`, four from `a0de2469...`, and 15 explicit
  production-working-tree files. The runtime entrypoint equals production
  `docker-entrypoint.sh`.
- YFS worker: 27/27 application files exact to the current production composite:
  20 from `e6a0a833...`, six preserved production-only files, and the deployment
  marker. Fifteen post-start screenshots are excluded.
- Audio Bridge: 24/24 application files exact to `e6a0a833...`. The same subset
  exists at the protected `b38b22d3...` DEV checkpoint, but that does not make the
  DEV checkpoint production authority.

## Rows requiring corrected privileged evidence

- Gravity: 291 non-generated files are mapped (258 `e6a0...`, 26 `f975...`, one
  `74657f82...`, six dirty production/preserved files). The artifact also has 3,657
  `.next/**` records; 954 match no candidate and no candidate BUILD_ID matches.
  Unmatched generated path-set digest:
  `ee087565e76f24bcae837658b6898330fc6e2bc27ee99588c0fe7b8cb864e56a`.
- Telegram frontend: four source/static records match `e6a0...`; all 75 `.next/**`
  records are absent from candidates. Generated path-set digest:
  `e3787c1e7c3c7d87a58b8b7749c357eddf17b15d47564c8ff71d7b4f576017e4`.
- YFS API: 24/25 records map. Runtime `/app/src/worker.ts` has SHA-256
  `c14327159069d8f49071d78209b380f1baf646577a00473bfc295f87bde6ce15`
  and is absent from every targeted source candidate. Its image/writable origin is
  acceptance-critical.
- FreeSWITCH: the v1 component is not acceptance-safe. A corrected capture must omit
  all 12 known secret roots, capture the 12 non-secret fixed roots, and prove their
  image/writable origin.

## Sanitized derivative

`../runtime-manifests/runtime-content-manifest.v1.sanitized.json` removes three
Gravity browser/profile records, three MAX state records, 15 YFS screenshots, and
all 444 FreeSWITCH v1 records. SHA-256:
`1bd1d5100cabeb37277262179ee1119b3dcd9154b9774947dcf218d38e4d19fe`.

The corrected v3 broker must be installed before any unresolved row can be promoted
to `PROVEN_ARTIFACT_WITH_UNRECORDED_PROVENANCE`.
