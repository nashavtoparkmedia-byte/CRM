# CRM-ARCH-000R Production-Only Evidence Snapshot

This directory is an authorized evidence-preservation snapshot. It is not an architecture baseline, release, commit, or deployment artifact.

## Capture identity

- Snapshot: `20260808T070726Z`
- Source host: `jvxthcorvm`
- Source root: `/opt/crm`
- Production HEAD: `e6a0a833fbb756216b058bfe326f9f9c77c4cc6d`
- Observation start: `2026-08-08T07:07:26.475228Z`
- Observation end: `2026-08-08T07:07:26.637868Z`
- Accepted file entries: `28`
- Prior/current SHA-256 matches: `28`
- Exact content files preserved: `27`
- Content files excluded by secret-safe handling: `1`

## Secret-safe handling

All 28 files were scanned in memory for private-key material, well-known credential/token forms, credentials embedded in URLs, suspicious sensitive literal assignments, and non-empty defaults for sensitive environment identifiers. Secret values were never emitted.

`deploy/docker-compose.production.yml` produced three findings for a non-empty default attached to a sensitive password identifier. Its exact whole-file SHA-256 and source metadata are retained, but its content is intentionally absent. Safe finding metadata is under `exclusions/`. No other file produced a finding.

## Package digest

`PACKAGE_CONTENTS.tsv` is a canonical UTF-8, relative-path-sorted ledger. Each line contains `SHA-256<TAB>byte-size<TAB>relative-path<LF>` for every evidence payload file other than `PACKAGE_CONTENTS.tsv` and `PACKAGE_SHA256`. The complete package SHA-256 is the SHA-256 of the exact ledger bytes and is stored in `PACKAGE_SHA256`. This definition avoids checksum self-reference and is deterministic.

Verification from the snapshot root: `sha256sum -c PACKAGE_SHA256`. Verify each ledger member by comparing its listed digest and size; `manifest.json` provides source metadata and old/current hashes.

## File ledger

| Relative original path | Old reported SHA-256 | Current SHA-256 | Bytes | Source mode | Source UID:GID | Source mtime UTC | Content |
|---|---|---|---:|---:|---:|---|---|
| `deploy/docker-compose.production.yml` | `84a9f46904a65a69afcf19d2e56162e026b29718da52c43160abfc5449f84cc1` | `84a9f46904a65a69afcf19d2e56162e026b29718da52c43160abfc5449f84cc1` | 26817 | `0644` | `0:0` | `2026-08-06T17:41:20.834356021Z` | `EXCLUDED_SECRET_SAFE` |
| `gravity-mvp/Dockerfile` | `02a316598d5ebfe6a54afcf3b9ef40b5a7e3eaad762219d1f7ce04927654c9ff` | `02a316598d5ebfe6a54afcf3b9ef40b5a7e3eaad762219d1f7ce04927654c9ff` | 7321 | `0644` | `0:0` | `2026-07-16T17:31:08.744076274Z` | `PRESERVED_EXACT` |
| `gravity-mvp/Dockerfile.hotfix` | `97c0c8ec3e5690d5b83c9308bbf06de402bc59f053090ab092b63957c247a3ae` | `97c0c8ec3e5690d5b83c9308bbf06de402bc59f053090ab092b63957c247a3ae` | 1691 | `0644` | `0:0` | `2026-07-16T19:53:46.403413659Z` | `PRESERVED_EXACT` |
| `gravity-mvp/Dockerfile.hotfix2` | `43f78f0105bd5868bcaa7397baf31467af2212f72af20676695614a4e37e70b2` | `43f78f0105bd5868bcaa7397baf31467af2212f72af20676695614a4e37e70b2` | 1206 | `0644` | `0:0` | `2026-07-16T19:59:30.768476378Z` | `PRESERVED_EXACT` |
| `gravity-mvp/Dockerfile.hotfix3` | `76b89c2b329fc808acb44509691a920074c04ebe8565a8f0dadc1d3510f0e2af` | `76b89c2b329fc808acb44509691a920074c04ebe8565a8f0dadc1d3510f0e2af` | 1156 | `0644` | `0:0` | `2026-07-16T20:11:28.630711293Z` | `PRESERVED_EXACT` |
| `gravity-mvp/prisma/migrations/20260717000000_add_driver_telegram_submitted_phone/migration.sql` | `03013fdf531f45c3b012c13fa15581be29f6399019f5b1dd308c4f8c407ae7e5` | `03013fdf531f45c3b012c13fa15581be29f6399019f5b1dd308c4f8c407ae7e5` | 457 | `0644` | `0:0` | `2026-07-16T19:51:32.461390024Z` | `PRESERVED_EXACT` |
| `gravity-mvp/prisma/schema.prisma` | `fdf711a943dd453c136f498b0005f739795b865b751867856eb0b8090a946a81` | `fdf711a943dd453c136f498b0005f739795b865b751867856eb0b8090a946a81` | 87278 | `0644` | `0:0` | `2026-08-05T08:46:26.893161318Z` | `PRESERVED_EXACT` |
| `gravity-mvp/src/app/api/bot-users/route.ts` | `040cb8f97eb1eded84fc2c07e98986c3b4cd9c0dfbb2b408b1af9a6d9a6c5481` | `040cb8f97eb1eded84fc2c07e98986c3b4cd9c0dfbb2b408b1af9a6d9a6c5481` | 13456 | `0644` | `0:0` | `2026-08-05T09:12:59.580868348Z` | `PRESERVED_EXACT` |
| `gravity-mvp/src/app/api/webhook/telegram/route.ts` | `3ccabb275e924599be0c251b06ca926175890ebb138a8a018634f07991fcd1a6` | `3ccabb275e924599be0c251b06ca926175890ebb138a8a018634f07991fcd1a6` | 19384 | `0644` | `0:0` | `2026-08-05T08:46:26.893161318Z` | `PRESERVED_EXACT` |
| `gravity-mvp/src/app/api/webhooks/bot/route.ts` | `5d7382705c64d1c679aecdb5eb75e47ad912da0c23544af0cb9457edd2552d82` | `5d7382705c64d1c679aecdb5eb75e47ad912da0c23544af0cb9457edd2552d82` | 60133 | `0644` | `0:0` | `2026-08-05T08:46:26.893161318Z` | `PRESERVED_EXACT` |
| `gravity-mvp/src/app/api/webhooks/max/route.ts` | `2a13e48acdb5ce3ef7c7fe55967ed8dbc7342ea5dcef397caafe1f8833cf8cf8` | `2a13e48acdb5ce3ef7c7fe55967ed8dbc7342ea5dcef397caafe1f8833cf8cf8` | 25628 | `0644` | `0:0` | `2026-08-04T07:49:45.627876536Z` | `PRESERVED_EXACT` |
| `gravity-mvp/src/app/settings/integrations/bot/BotPageClient.tsx` | `d580311706422564f49a7f6a98d64fbb46108c7e0249deb1bcfe34a3f1a1bf11` | `d580311706422564f49a7f6a98d64fbb46108c7e0249deb1bcfe34a3f1a1bf11` | 20863 | `0644` | `0:0` | `2026-08-05T09:12:59.580868348Z` | `PRESERVED_EXACT` |
| `gravity-mvp/src/lib/DriverMatchService.ts` | `abdc925ab88d0432b6fe8745ea1aa4131ed0aa333640b2a5f7ca2e639cafba8b` | `abdc925ab88d0432b6fe8745ea1aa4131ed0aa333640b2a5f7ca2e639cafba8b` | 7189 | `0644` | `0:0` | `2026-07-16T17:43:34.949942958Z` | `PRESERVED_EXACT` |
| `gravity-mvp/src/lib/botDriverResolver.ts` | `e76d0e4938d4fddde8b54ecd69384cd087649af5a255ba925902174fd3966eb0` | `e76d0e4938d4fddde8b54ecd69384cd087649af5a255ba925902174fd3966eb0` | 3414 | `0644` | `0:0` | `2026-07-16T17:43:34.949942958Z` | `PRESERVED_EXACT` |
| `gravity-mvp/src/lib/botLinking.ts` | `ec9f73ecfd8f4805f58b96a97ce3ad7ec4f05c19be3bac03014614872ac50fad` | `ec9f73ecfd8f4805f58b96a97ce3ad7ec4f05c19be3bac03014614872ac50fad` | 3239 | `0644` | `0:0` | `2026-08-05T08:17:35.660125177Z` | `PRESERVED_EXACT` |
| `max-web-scraper/scripts/check_recent_max.js` | `5272a723116b046f03d4520b04cceccddb0b3469ffe5005b333c6d0fcbc8430d` | `5272a723116b046f03d4520b04cceccddb0b3469ffe5005b333c6d0fcbc8430d` | 806 | `0644` | `0:0` | `2026-06-21T19:35:40.481634927Z` | `PRESERVED_EXACT` |
| `max-web-scraper/scripts/test_webhook_push.js` | `ddbfd171f8a4951cecbf0311e0c78f1516e32fb2463b9c06bf97fe43ea5b4f25` | `ddbfd171f8a4951cecbf0311e0c78f1516e32fb2463b9c06bf97fe43ea5b4f25` | 1211 | `0644` | `0:0` | `2026-06-21T19:59:17.509656365Z` | `PRESERVED_EXACT` |
| `tg-bot/src/bot.js` | `cb42c7c3db4d0dcbd99d5f723add5fb8d9400c29fbb91e99f1ec39bcf2b0ac7c` | `cb42c7c3db4d0dcbd99d5f723add5fb8d9400c29fbb91e99f1ec39bcf2b0ac7c` | 14395 | `0644` | `0:0` | `2026-08-05T08:17:35.660125177Z` | `PRESERVED_EXACT` |
| `tg-bot/src/handlers/carManagement.js` | `557ad97d1632daf681c3a7c048f2d3078e8b7ecee4a395c6cded213ae50fc590` | `557ad97d1632daf681c3a7c048f2d3078e8b7ecee4a395c6cded213ae50fc590` | 16775 | `0644` | `0:0` | `2026-08-05T08:17:35.664125232Z` | `PRESERVED_EXACT` |
| `tg-bot/src/handlers/driverOrder.js` | `1eb965d5e88b630d29fd0f1ea0e43f8cedcc6f28f377fdee99e5879a937de11a` | `1eb965d5e88b630d29fd0f1ea0e43f8cedcc6f28f377fdee99e5879a937de11a` | 18488 | `0644` | `0:0` | `2026-08-05T08:17:35.664125232Z` | `PRESERVED_EXACT` |
| `tg-bot/src/routes/crm.js` | `6dc097d53858c893fd8c51df42de113d19b3be7cc43bbef5ec3f627c494037d0` | `6dc097d53858c893fd8c51df42de113d19b3be7cc43bbef5ec3f627c494037d0` | 3802 | `0644` | `0:0` | `2026-08-05T09:24:42.054240294Z` | `PRESERVED_EXACT` |
| `tg-bot/test/bot-runtime.test.js` | `4233b5312373e9708bbc4635352260365e060aec1401e49c7d41b50c844b69d0` | `4233b5312373e9708bbc4635352260365e060aec1401e49c7d41b50c844b69d0` | 3542 | `0644` | `0:0` | `2026-07-10T14:27:58.219240466Z` | `PRESERVED_EXACT` |
| `yandex-fleet-scraper/src/api.ts` | `917b4af047d9017cac90eeb61e8824fc2f9c52b5ac5c10457fb0975ab4468999` | `917b4af047d9017cac90eeb61e8824fc2f9c52b5ac5c10457fb0975ab4468999` | 15516 | `0644` | `0:0` | `2026-07-15T22:23:14.267011195Z` | `PRESERVED_EXACT` |
| `yandex-fleet-scraper/src/lib/captcha.ts` | `81e2c2aa2cddd129ca7c12cf264445ed83f5c0a0b0e4353521e05234b4c8d904` | `81e2c2aa2cddd129ca7c12cf264445ed83f5c0a0b0e4353521e05234b4c8d904` | 1723 | `0644` | `0:0` | `2026-07-16T07:51:15.733892178Z` | `PRESERVED_EXACT` |
| `yandex-fleet-scraper/src/lib/order-locator.ts` | `b94c87ff34101efb1fd030f62de18783dfe21448e154aa9b02524b17756f9b14` | `b94c87ff34101efb1fd030f62de18783dfe21448e154aa9b02524b17756f9b14` | 2587 | `0644` | `0:0` | `2026-08-03T16:58:57.406386825Z` | `PRESERVED_EXACT` |
| `yandex-fleet-scraper/src/worker.ts` | `513c57d795197887dcbdbf54c61cc02a46954274585f718723aa31cfeb01df17` | `513c57d795197887dcbdbf54c61cc02a46954274585f718723aa31cfeb01df17` | 74795 | `0644` | `0:0` | `2026-08-03T16:58:57.406386825Z` | `PRESERVED_EXACT` |
| `yandex-fleet-scraper/tests/captcha.test.ts` | `433712a06fcd6a517a06f210a0bffb0b5d93ac4cec37afc0c9a02668a5c0079f` | `433712a06fcd6a517a06f210a0bffb0b5d93ac4cec37afc0c9a02668a5c0079f` | 1275 | `0644` | `0:0` | `2026-07-16T07:51:15.733892178Z` | `PRESERVED_EXACT` |
| `yandex-fleet-scraper/tests/order-locator.test.ts` | `5696ed34caf4c4d5b24fed3addf407ea03e057051c1958ea16a533bf94e42a2c` | `5696ed34caf4c4d5b24fed3addf407ea03e057051c1958ea16a533bf94e42a2c` | 2407 | `0644` | `0:0` | `2026-08-03T16:58:57.406386825Z` | `PRESERVED_EXACT` |

All source files remained byte- and metadata-stable during capture. No production source file, Git index/ref, service, container, database, or configuration was modified by this preservation step.
