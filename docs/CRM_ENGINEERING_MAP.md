Verified against main: `04839381b798c09ae52d3cea35b4a18597a45685`
Tree: `8e80f60b549271d588df3539e2145b6ad022e3aa`
Generated/verified: 2026-10-03

# YOKO CRM — Engineering Map

Scope of verification: repository contents at the commit above, read-only. Nothing
here describes the production host, its `.env.production`, compose overlays, the
live database, or any unmerged branch. Where the repository cannot answer a
question, the text says so.

Path shorthand used throughout: `G/` = `gravity-mvp/src/`. All other paths are
relative to the repository root.

This document is a navigation aid. It is **not** an architecture authority: root
`AGENTS.md` and the machine registries under `architecture/` and
`tools/architecture/` remain authoritative (see §1.3).

---

## AI ENGINEERING ENTRYPOINT

Root `AGENTS.md` requires reading this map before substantial feature, domain,
schema, integration, runtime or cross-domain work. Follow these rules before
designing any change.

1. **YOKO CRM is a modular monolith.** Its 16 bounded contexts already exist
   (§2); work happens inside them.
2. **A new screen, menu item, workflow or product section does not by itself
   justify a new domain or bounded context.**
   `NEW PRODUCT SECTION != NEW DOMAIN` · `NEW SCREEN != NEW DOMAIN` ·
   `NEW WORKFLOW != NEW DOMAIN`. Example on main: Cash Compensation is a product
   section with its own UI, bot scene and 13 tables, and it lives inside
   `fleet_operations` (§2.7).
3. **Identify the owning existing domain first** — §2 (domain map) or §12 (quick
   index), starting from the business capability being changed.
4. **Identify existing capabilities and public extension points** — §5 (change
   routing matrix). Check whether the capability already exists before adding one.
5. **Identify ownership and invariants** — data owners in §3, invariants in §7. A
   foreign table is written only through its owner's public surface; respect the
   "do not touch directly" column of §5.
6. **Identify the required verification** — §6.
7. **Only after this orientation, inspect the relevant implementation paths** —
   the start paths listed for the capability. Do not sweep the repository.
8. **Prefer extending the existing owner/domain** over inventing a parallel
   abstraction, a second implementation, or a new layer beside a live one.
9. **Do not build new functionality on `LEGACY / COMPATIBILITY` surfaces** unless
   the task explicitly is compatibility work. On main these are: the status-**L**
   models in §3 (the 27 archived-lineage `Max*` models, `MaxPersonalSession`,
   `DriverMax`, `ContactDriverProfileAudit`), tombstone routes, deprecated
   re-export shims, and anything listed under OBSERVED DEBT (§9–§11). Note the
   difference: the legacy-named `G/lib/*` core is **live**, not legacy surface.
10. **If repository evidence contradicts this map: `STOP / SYSTEM MAP DRIFT`**
    (see below).

**Authority.** Current source, manifests, contracts and enforcement are
authoritative. This map is navigation and synthesised engineering knowledge, not
a second source of architectural truth. It never overrides `AGENTS.md`, the
registries under `architecture/`, or the code.

**Maintenance.** Substantial work ends with a report line
`CRM_ENGINEERING_MAP IMPACT = NONE` or
`CRM_ENGINEERING_MAP IMPACT = UPDATE REQUIRED` (with affected sections and
reason), as defined in root `AGENTS.md`.

Three facts that most often mislead a newcomer:

- **The legacy `G/lib/*` layer is live, not a facade.** `G/lib/MessageService.ts`,
  `G/lib/ContactService.ts`, `G/lib/whatsapp/WhatsAppService.ts`,
  `G/app/tg-actions.ts`, `G/lib/freeswitch/EslClient.ts` hold the real logic; most
  `G/modules/*/public/v1` files are thin handlers plus `legacy-prisma-*` adapters
  that wrap them.
- **The scheduler is `G/instrumentation.ts`**, not the `/api/cron/*` routes
  (§4, F-29).
- **Governance pins source by hash.** Editing, adding or deleting a tracked
  executable file usually requires registry rebinds (§1.3, §6.3). Plan for it.

If repository evidence contradicts this map:

```
STOP / SYSTEM MAP DRIFT
```

Report the discrepancy (path, what the map says, what the code says). Do not
assume this document is newer than the code. Re-verify against
`git rev-parse HEAD` — if it is not the SHA above, treat every statement here as a
hint to be checked.

---

# CURRENT VERIFIED SYSTEM

## 1. Repository orientation

### 1.1 Top-level directories

| Directory | What lives here | Go here when |
|---|---|---|
| `gravity-mvp/` | The CRM: Next.js 16 / React 19 / Prisma 6 monolith, port 3002. UI, API routes, server actions, in-process background jobs, provider runtimes (Telegram MTProto, WhatsApp) | Almost every product change |
| `gravity-mvp/src/modules/` | 16 bounded-context modules (`application/`, `internal/`, `public/v1`) | You need a domain's public surface or adapters |
| `gravity-mvp/src/contracts/` | Versioned command/event parsers per context (`<ctx>/v1`, some `v2`) | Adding or reading a cross-context payload |
| `gravity-mvp/src/lib/` | Legacy core, still the live implementation for messaging, contacts, WhatsApp, calling ESL, tasks, ops | Changing actual behaviour of those areas |
| `gravity-mvp/src/app/` | Next.js App Router: pages, `route.ts` API (143 routes), server actions | UI, HTTP surface, webhooks |
| `gravity-mvp/src/infrastructure/` | Cross-context composition: outbox store/publisher, contact-merge composition, shared UI primitives (`ui/`), provider clients, Telegram/WhatsApp operational capabilities | Wiring several contexts together |
| `gravity-mvp/src/instrumentation.ts` | Boot sequence and every in-process periodic job | Adding/changing a background job or boot registration |
| `gravity-mvp/src/proxy.ts` | Next.js request proxy (middleware): debug-route deny and mobile-shell session gate | Request-level gating |
| `gravity-mvp/prisma/` | `schema.prisma` (135 models) and 53 migration directories | Any schema change (governed — §6.3) |
| `gravity-mvp/scripts/` | 216 operator/diagnostic/backfill scripts; not in the production image | Looking for an existing operator CLI; do not add casually |
| `gravity-mvp/test/` | 5 cross-cutting vitest files (MAX delivery) | MAX delivery boundary tests |
| `tg-bot/` | Separate Node process: Telegraf bot + Express API (3001). `tg-bot-frontend/` is a Next 14 pages-router admin (3004) | Driver-facing Telegram bot, surveys, bot scenes |
| `max-web-scraper/` | Separate Node process: Playwright scraper of MAX web, Express API (3005) | Anything MAX transport-side |
| `yandex-fleet-scraper/` | Fastify API (3003) + BullMQ/Playwright worker, own SQLite | Yandex Fleet UI scraping checks and driver actions |
| `avito-worker/` | Avito response collector (Drizzle, Playwright). Not a service in the production compose file | Avito lead intake, worker side |
| `telephony/` | FreeSWITCH image: Dockerfile, static `conf/`, vendored `third_party/mod_audio_fork`, tests | Dialplan, SIP, media runtime |
| `tools/audio-bridge-day1/` | The production AI-call audio bridge service (despite the name) | AI call STT/LLM/TTS loop, channel lifecycle |
| `tools/architecture/` | ~250 governance controls: enforcement, boundary checks, migration authority, CI runner | Any governance failure; before adding files/contracts/migrations |
| `tools/fs-config/` | Manual-copy FreeSWITCH XML variant (differs from `telephony/conf`) | Rarely; see debt C-30 |
| `architecture/` | Machine authority: context manifests, contract registry, enforcement policy, outbox manifest, migration authority, isolation packages, recovery/review evidence | Ownership questions; governance rebinds |
| `android/` | Kotlin single-activity WebView shell + FCM push | Mobile shell, push receive |
| `deploy/` | `docker-compose.production.yml`, `docker-compose.test.yml`, nginx templates, age public key | Runtime topology, edge routing |
| `scripts/` (root) | Deploy, backup/restore, health monitor, server setup shell scripts | Operations procedures |
| `docs/` | `architecture/`, `design/`, `engineering/`, `mobile/`, `operations/`, `DEPLOY.md`, `SECRETS.md` | Design intent and runbooks (some stale — C-10) |
| `.github/workflows/` | 4 workflows (§6.2) | CI behaviour |
| `.codex/`, `.agents/`, `.claude/` | Agent profiles, skills, knowledge notes | Agent tooling; `.claude/knowledge/max_chat_merging.md` is obsolete |

### 1.2 Not source (do not treat as code)

- `yandex-fleet-scraper/.artifacts/` — 107 committed PNG screenshots.
- `gravity-mvp/*.txt`, `*.json` dumps, `dev.db`, `baseline.prisma`,
  `current_schema.prisma.*` at the `gravity-mvp/` root — captured output and stale
  copies.
- `max-web-scraper/*.png`, `debug_*.txt`, `max_dom_dump.txt` — debug captures.
- `architecture/recovery/**` — frozen evidence, review registries, and ~740 MB of
  runtime-package binaries. A handful of registries there are **live inputs** to
  CI (§1.3).
- `architecture/migrations/v1/archive/pre-outbox/` — historical migration SQL
  that Prisma must never discover (§6.3).

### 1.3 Governance in one page

| Artifact | Role | Maintained |
|---|---|---|
| `AGENTS.md`, `docs/architecture/AGENT_DEVELOPMENT_CONTRACT.md`, `docs/architecture/NEW_DOMAIN_CHECKLIST.md` | Mandatory rules for agents | By hand; checked by `tools/architecture/check-agent-architecture-contract.mjs` |
| `architecture/contexts/v1/manifests/*.json` (16) | Base ownership: paths, data, public surface, dependencies, verification commands | Generated from `context-decisions.json` |
| `architecture/enforcement/v1/policy.json` → `manifest_amendments` (≈60 files under `architecture/isolation/**/module-manifest-amendments.json` and `architecture/events/v1/`) | **Extends** base ownership. Compensation, AI-call campaign, mobile-push and outbox ownership live here, not in the base manifests | By hand per extraction |
| `architecture/contexts/v1/context-index.json` | Hash pins of manifests, 17 control files, 6 generated outputs | Generated; verified by `validate-context-manifests.mjs` |
| `architecture/contracts/v1/registry.json` | Public surfaces per context + 4 concrete contracts (all `work_management` task commands) + interactions | Reconciled by `reconcile-contract-registry.mjs` |
| `architecture/contexts/v1/executable-path-ownership-coverage.json` | Every tracked executable surface is either context-owned or a governed exclusion | Generated; denominator pinned in `test-executable-path-ownership.mjs` |
| `architecture/recovery/whole-project-dod/v2/LIFECYCLE_SURFACE_CLASSIFICATION_REGISTRY.json` | Lifecycle class and `source_sha256` of scripts and other surfaces | By hand; consumed by full-scan controls |
| `architecture/events/v1/outbox-manifest.json` | Declared outbox flows | By hand; `check-outbox-architecture.mjs` |
| `architecture/migrations/v1/*.json` | Migration authority (§6.3) | Frozen + appendable pending file |

Consequences for everyday work:

- A base manifest that lists no owner for a model does **not** mean the model is
  unowned: check the amendments first.
- The manifests' `current_writer_modules` lists and several `owned_paths` are
  stale relative to the code (examples in C-12). Trust the code for "who writes".
- `architecture/**/SHA256SUMS` files are not enforced by CI; the live pins are
  `context-index.json`, registry `source_sha256` fields and constants in tests.

---

## 2. Domain / module map

The 16 contexts below are the ones declared in
`architecture/contexts/v1/context-index.json`. "Public surface" names come from
the manifests; several are declarative only and have no code symbol of that name.
Each entry lists what the code actually does.

### 2.1 Messaging (`messaging`)

- **Purpose**: channel-neutral conversations and messages, outbound send,
  retry/recovery, realtime stream, inbound AI reply/draft orchestration, mobile
  push intent.
- **Key paths**
  - `G/lib/MessageService.ts` — the real send / retry / recover / list logic.
  - `G/lib/ConversationWorkflowService.ts` — Chat status, unread, assignment (raw SQL).
  - `G/lib/messageEvents.ts`, `G/lib/messageStreamBus.ts`, `G/lib/TransportRegistry.ts`.
  - `G/modules/messaging/application/messaging-operations.ts` — composition root
    exporting the `*V1` operations.
  - `G/modules/messaging/public/v1/` — handlers + `legacy-prisma-*` adapters;
    runtime ports `channel-delivery-runtime.ts`,
    `outbound-conversation-identity-runtime.ts`, `message-stream.ts`,
    `persisted-message-ingress.ts`, `delivery-recovery-operations.ts`.
  - `G/modules/messaging/internal/ai-reply-pipeline/`, `internal/mobile-push/`.
  - `G/contracts/messaging/v1` (and `v2` for attach-media).
  - UI: `G/app/messages/`; HTTP: `G/app/api/messages/**`, `G/app/api/chats/**`.
- **Owns**: `Chat`, `Message`, `MessageAttachment`, `MessageEventLog`,
  `HistoryImportJob`, `CommunicationTrigger`, `GroupVisibility`.
- **Reads without owning**: `Contact*`, `Driver`, provider connection tables.
- **Upstream**: contacts, identity_access, work_management, ai_knowledge, calling,
  fleet_operations. **Downstream**: the three channel contexts, platform_shell,
  avito, analytics.
- **Public read — Contact → conversations**: `ContactConversationsQuery.v1` →
  `ContactConversationsResult.v1` (`contactConversationsV1` from
  `G/modules/messaging/public/v1`; browser transport
  `G/app/messages/contact-conversations-actions.ts`, no `app/api` route). 1..25
  Contact ids; per id `not_found`, or `found` with `canonicalContactId`, an
  ordered array of channel contexts (`primaryConversationId` + conversations),
  `latestConversationId` (null when none) and `truncated` (more than 50 exist:
  partial, never proof of absence — `contactChannelConversationsV1` answers
  `unknown`). Replaces the legacy `/api/contacts/search` `hasChat` signal for
  NewChatPopover / ChatList (M3A6D); see I-45.
- **Extension points**: delivery port interfaces in `channel-delivery-runtime.ts`;
  new persisted command = contract + handler + adapter + wiring in
  `messaging-operations.ts`; new outbox event = contract +
  `messagingOutboxPublishersV1` + outbox manifest. Which Contact a conversation
  belongs to: `ResolveConversationContactQuery.v1` (`resolveConversationContactV1`
  from `G/modules/messaging/public/v1`) — read-only, by exact `Chat.id`, answers
  `resolved` (the canonical Contact after Contacts' merge lineage), `unresolved`,
  `ambiguous` (the recorded `metadata.contactResolution.status`, whatever link the
  Chat carries) or `not_found`; no provider, account or transport detail crosses it.
- **Tests**: colocated vitest under `G/modules/messaging/**`,
  `G/lib/MessageService.provider-account.test.ts`,
  `G/app/api/messages/*/route.test.ts`; `tools/architecture/check-messaging-*-boundary.mjs`.
- **Runtime**: single Gravity process; SSE bus is in-process memory.

### 2.2 Contacts (`contacts`)

- **Purpose**: canonical people, phones, channel identities, resolution, merge,
  reachability.
- **Key paths**
  - `G/lib/ContactService.ts` — live phone/identity mutation core.
  - `G/lib/contacts/ContactResolutionService.ts` (read-only planner),
    `G/lib/contacts/SafeContactResolutionExecutor.ts` (admitted executor),
    `G/lib/contacts/yandex-link.ts`.
  - `G/modules/contacts/internal/contact-ownership-coordinator.ts` — advisory
    lock, ordered row locks, postconditions.
  - `G/modules/contacts/public/v1/` — `contact-identity-maintenance.ts`
    (`resolveChannelContactOperationV1`), `phone-identity.ts`
    (`normalizePhoneE164`), `contact-merge-handler.ts`,
    `contact-automation-policy.ts`, `contact-reachability.ts`.
  - `G/infrastructure/contact-merge-composition.ts`,
    `G/infrastructure/automatic-contact-merge.ts`; facade `G/lib/ContactMergeService.ts`.
  - `G/lib/ReachabilityService.ts`.
  - HTTP: `G/app/api/contacts/**`, `G/app/api/contact-merges/[id]/recover`.
  - UI: `G/app/messages/components/ContactProfileDrawer.tsx`.
- **Owns**: `Contact`, `ContactPhone`, `ContactIdentity`, `ContactMerge`.
- **Consumers**: every inbound channel path, ESL call journal, lead intake, fleet
  reconciler, platform-shell orchestrators.
- **Extension points**: new identity channel (`ChatChannel` enum,
  `G/lib/contacts/contact-resolution.types.ts`, default evidence in
  `ContactService.ts`); merge rule (`contact-automation-policy.ts`); a new table
  that must be re-pointed on merge needs a repository in `contact-merge-handler.ts`
  and an adapter wired in `contact-merge-composition.ts`.
- **Tests**: `G/lib/__tests__/contact-resolution-*.test.ts`,
  `safe-contact-resolution-executor(.postgres).test.ts`,
  `G/modules/contacts/**/*.test.ts`, `G/app/api/contacts/**/route.test.ts`;
  `tools/architecture/check-contact*-boundary.mjs`.

### 2.3 Telegram channel (`telegram_channel`)

- **Purpose**: two Telegram lanes — operator MTProto accounts inside Gravity, and
  the driver-facing bot (`tg-bot/`) with its admin frontend.
- **Key paths**
  - `G/app/tg-actions.ts` — the whole MTProto/GramJS runtime (login, client cache,
    listeners, catch-up, send, media, history import, reachability).
  - `G/modules/telegram-channel/public/v1/` — `runtime-operations.ts`,
    `messaging-delivery-capability.ts`, `bot-message-delivery.ts`,
    `bot-transport-config.ts` (the canonical Driver Bot transport id), driver-link
    and bot-user-profile handlers/adapters.
  - `G/infrastructure/telegram/operational-capabilities.ts`.
  - Bot-side in CRM: `G/app/api/webhook/telegram/route.ts` (bot messages in),
    `G/app/api/webhooks/bot/route.ts` (bot action RPC), `G/app/tg-bot-actions.ts`,
    `G/app/api/bot-link/route.ts`, `G/app/api/bot-users/route.ts`.
  - `tg-bot/start.js`, `tg-bot/src/bot.js`, `tg-bot/src/app.js`,
    `tg-bot/src/services/crmIntegration.js`, `tg-bot/src/handlers/*`.
- **Owns**: `TelegramConnection`, `DriverTelegram`, `BotUserRegistry`,
  `BotChatMessage`, bot survey tables (`bots`, `surveys`, `questions`, `users`,
  `answers`, `analytics_events`, `broadcasts`, `broadcast_stats`), tg-bot SQLite.
- **Runtime**: MTProto session in `TelegramConnection.sessionString`; clients and
  listeners are module-level Maps in the Gravity process. `tg-bot` shares the CRM
  Postgres (`DATABASE_URL`) and also keeps a local SQLite file. The Driver Bot
  transport id comes only from configuration: `CRM_TELEGRAM_CONNECTION_ID`, read
  by `canonicalTelegramBotConnectionIdV1()`. It is never taken from a stored
  `Chat` or `TelegramConnection` row, and a missing, untrimmed or placeholder
  value fails closed (`TELEGRAM_BOT_CONNECTION_CONFIG_UNPROVEN`).
- **Extension points**: `TelegramChannelDeliveryV1` in
  `channel-delivery-runtime.ts`; a new bot action = a `case` in
  `G/app/api/webhooks/bot/route.ts` + a tg-bot handler.
- **Tests**: `G/app/tg-actions.identity.test.ts`,
  `G/app/api/webhook/telegram/route.test.ts`, module tests;
  `tg-bot/src/security/*.test.js`; `check-telegram-*-boundary.mjs`.

### 2.4 WhatsApp channel (`whatsapp_channel`)

- **Purpose**: WhatsApp sessions (whatsapp-web.js + Puppeteer inside the Gravity
  process), history sync, delivery, provider mirror tables.
- **Key paths**: `G/lib/whatsapp/WhatsAppService.ts` (everything),
  `G/lib/whatsapp/WhatsAppCleanup.ts`, `whatsapp-qr-ceremony.ts`;
  `G/modules/whatsapp-channel/public/v1/` (`runtime-operations.ts`,
  `messaging-delivery-capability.ts`, `identity-canonicalization.ts`);
  `G/infrastructure/whatsapp/operational-capabilities.ts`;
  `G/app/settings/integrations/whatsapp/`.
- **Owns**: `WhatsAppConnection`, `WhatsAppChat`, `WhatsAppMessage`,
  `WhatsAppChatRoster`.
- **Runtime**: `LocalAuth` files under `WA_AUTH_PATH`; clients in a global Map;
  boot warm-up and a 60 s watchdog in `G/instrumentation.ts`.
- **Extension points**: `WhatsAppChannelDeliveryV1`; message-type mapping
  functions in `WhatsAppService.ts` (repeated across live, sync and import paths).
- **Tests**: `G/lib/whatsapp/WhatsAppService.connection-binding.test.ts`,
  `whatsapp-qr-ceremony.test.ts`; `check-whatsapp-runtime-provider-boundary.mjs`,
  `check-messaging-whatsapp-*-boundary.mjs`.

### 2.5 MAX channel (`max_channel`)

- **Purpose**: MAX messenger via a web scraper (the only transport on main).
- **Key paths**
  - `max-web-scraper/index.js` (Express app, send paths, DOM recovery),
    `transport/TransportInterceptor.js` (WebSocket hook + decoder),
    `session/SessionController.js`, `parser/MessageParser.js`,
    `sync/{MessageSync,InitialHistorySync,NameSync}.js`,
    `media/MediaPipeline.js`, `lib/MaxWebReplyBridge.js`.
  - `G/app/api/webhooks/max/route.ts` — the only live ingress;
    `G/app/api/webhook/max/reaction/route.ts` — reaction ingress.
  - `G/modules/max-channel/public/v1/messaging-delivery-capability.ts`,
    `G/modules/max-channel/application/messaging-transport.ts`,
    `G/modules/max-channel/internal/scraper-webhook-auth.ts`.
  - `G/app/max-actions.ts` — `MaxConnection` CRUD server actions.
  - `G/app/api/max-scraper/*` — proxies to the scraper;
    `G/app/settings/integrations/max/`.
- **Owns**: `MaxConnection`, `DriverMax`, `MaxPersonalSession` (see §3 for the
  status of the other `Max*` models).
- **State location**: MAX conversation state is carried in `Chat.metadata`
  (`providerAccountId`, `senderId`, `chatKind`); scraper state is in the Playwright
  profile volume and JSON files. No MAX session state is persisted in Postgres.
- **Extension points**: `MaxChannelDeliveryV1`; webhook payload `source` /
  `chatKind`; the `OP` opcode table in `TransportInterceptor.js`.
- **Tests**: `G/app/api/webhooks/max/route.test.ts`,
  `gravity-mvp/test/max-*.test.ts`, `max-web-scraper/test/*` (manual only).

### 2.6 Calling and telephony (`calling`)

- **Purpose**: human calls (browser softphone ↔ FreeSWITCH ↔ SIP trunk), call
  journal, recordings, transcription/analysis, AI calls through the audio bridge,
  AI-call campaigns, call alerts. Also hosts AI agent config/profile handlers used
  by messaging AI replies.
- **Key paths**
  - `G/lib/freeswitch/EslClient.ts` — ESL listener, call journal, click-to-call.
  - `G/lib/freeswitch/recordingProcessor.ts`, `G/lib/queue/*` (BullMQ
    `call-transcribe`, `call-analyze`), `G/lib/aiCallAnalysis/*`.
  - `G/lib/ai-call/*` — scenarios, encrypted provider settings, `esl-originate.ts`.
  - `G/modules/calling/application/` — `ai-call-lifecycle.ts`,
    `ai-call-finalization*.ts`, `ai-call-campaign*.ts`,
    `controlled-real-ai-call*.ts`, `call-alert-operations.ts`.
  - `G/modules/calling/internal/` — `ai-calls/` adapters and
    `bridge-machine-auth.ts`, `call-alerts/`, `call-stream.ts`.
  - `G/modules/calling/public/v1/` — `sip-client-context.tsx` (JsSIP softphone),
    `client-ui/*`, `recording-storage.ts`, `outbox-consumers.ts`.
  - HTTP: `G/app/api/calls/**`, `G/app/api/ai-calls/**`,
    `G/app/api/internal/ai-call-keys/route.ts`. UI: `G/app/calls/`.
  - `telephony/conf/**`, `telephony/Dockerfile`; `tools/audio-bridge-day1/`
    (`server.js`, `channel-lifecycle.js`, `call-session.js`).
- **Owns**: `Call`, `AiCallMessage`, `AiCallEvent`, `AiCallScenario`,
  `AiCallProject`, `AiProviderSetting`, `AiAgentConfig`, `AiAgentProfile`,
  `TelephonyAiConfig`, and (via amendment) the six `AiCallCampaign*` /
  `AiCallAdmission*` models.
- **Runtime**: FreeSWITCH (host network, ESL 8021), audio bridge (port 3030),
  Redis/BullMQ, S3/MinIO, OpenAI (Whisper, chat), Yandex SpeechKit, coturn.
- **Extension points**: `AiCallCampaignDialPort`,
  `ControlledRealAiCallProviderPort`, `callingOutboxPublishersV1`, bridge
  `stt-router.js` / `tts-router.js`, `registerCompletedCallTimelineProjectorV1`.
- **Tests**: vitest under `G/modules/calling/**`; node:test in
  `tools/audio-bridge-day1/__tests__` and `G/lib/ai-call/__tests__`;
  `telephony/tests/`; `check-calling-*-boundary.mjs`.

### 2.7 Fleet operations (`fleet_operations`) — includes Cash Compensation

- **Purpose**: drivers, Yandex Fleet synchronisation, scraper checks, scoring and
  attention, driver communication events; **and the cash-compensation subdomain**.
- **Key paths (fleet)**
  - `G/modules/fleet-operations/internal/legacy-prisma-yandex-fleet-reconciler-adapter.ts`
    — the real reconciler.
  - `G/lib/yandexSync.ts` (lease + orchestration), `G/lib/YandexFleetService.ts`
    (`syncTrips`), `G/lib/scoring.ts`, `G/lib/DriverMatchService.ts`.
  - `G/modules/fleet-operations/public/v1/` — `yandex-fleet-operations.ts`,
    `yandex-connection-capability.ts`, `scheduled-scraper-check-dispatch.ts`.
  - `G/app/drivers/` (incl. `actions.ts`), `G/app/api/monitoring/**`.
  - `yandex-fleet-scraper/src/{api.ts,worker.ts,infrastructure/bullmq.ts}`.
- **Key paths (compensation)** — `COMP` = `G/modules/fleet-operations/internal/compensation`
  - `COMP/compensation-prisma-adapter.ts` — monetary core (raw SQL in transactions).
  - `COMP/cash-order-ingestion-runtime.ts`, `yandex-cash-order-source.ts`,
    `legacy-prisma-cash-order-ingestion-adapter.ts`, `cash-order-park-authority.ts`.
  - `COMP/compensation-pilot-service.ts`, `compensation-manager-service.ts`.
  - `G/modules/fleet-operations/application/{compensation-manager,compensation-pilot,compensation-budget-period,cash-order-ingestion}-operations.ts`.
  - UI: `G/app/compensation/`; bot scene: `tg-bot/src/handlers/compensation.js`;
    operator CLIs: `gravity-mvp/scripts/compensation-*.ts`.
- **Owns**: `Driver`, `DriverDaySummary`, `DriverEvent`, `DriverAttention`,
  `DriverAction`, `CommunicationEvent`, `ScoringThreshold`, `SyncStatus`,
  `ApiConnection`, `ApiLog`, `DailyParkStats`; the 13 `Compensation*` models (via
  amendments); scraper SQLite `Account`, `Check`, `CheckResult`, `AuditLog`.
- **Extension points**: handler + adapter under `public/v1`; compensation ports
  `CompensationPilotPortV1`, `CompensationManagerPortV1`, `CashOrderIngestionPortsV1`.
- **Tests**: `G/modules/fleet-operations/**/*.test.ts` (most are compensation;
  `*.postgres.test.ts` need a database), `G/lib/__tests__/yandex-sync-lease.test.ts`;
  `npm run test:compensation-proofs`; `check-fleet-*-boundary.mjs`,
  `check-compensation-edge-perimeter-boundary.mjs`.

### 2.8 Identity and access (`identity_access`)

- **Purpose**: operator identity, the three session mechanisms, integration-admin
  authorization, mobile device registration and the FCM transport.
- **Key paths**: `G/lib/users/user-service.ts`, `G/lib/users/auth-helpers.js`,
  `G/data/users.json`; `G/modules/identity-access/public/v1/`
  (`identity-actions.ts`, `integration-admin-auth.ts`, `mobile-session-auth.ts`,
  `mobile-push-registration-handler.ts`,
  `prisma-mobile-device-registration-adapter.ts`);
  `G/modules/identity-access/internal/mobile-delivery/`; `G/proxy.ts`;
  `G/app/login/`, `G/app/users/`, `G/app/api/mobile/push-registration/route.ts`.
- **Owns**: `CrmUser` (task assignees — **not** the login store) and
  `MobileDeviceRegistration` (via amendment). Operators themselves live in
  `G/data/users.json`.
- **Tests**: `G/lib/security/*.test.ts`, `G/lib/users/__tests__/*.test.js`,
  `npm run test:security-boundaries`; `check-identity-*-boundary.mjs`,
  `check-mobile-delivery-provider-boundary.mjs`.

### 2.9 Work management (`work_management`)

- **Purpose**: tasks, scenarios, dictionaries, task events, operational triggers.
- **Key paths**: `G/app/tasks/actions.ts` (the real task logic),
  `G/app/tasks/excel-actions.ts`, `G/lib/triggers.ts`, `G/lib/tasks/*`
  (`scenario-config.ts`, `task-event-service.ts`, `usage.ts`),
  `G/modules/work-management/public/v1/` (create / idempotent-create / assign /
  complete / reassign handlers, `client-state/*`), `G/data/dictionaries.json`.
- **Owns**: `Task` (`tasks`), `TaskEvent` (`task_events`), `ManagerTask`,
  `scenario_field_settings`, raw table `usage_events`.
- **Extension point for other contexts**: `createIdempotentTaskV1` (registered
  contract `work_management.CreateIdempotentTaskCommand.v1`).
- **Tests**: module tests (`create-idempotent-task-handler.test.ts` etc.);
  little coverage of `G/app/tasks/actions.ts` and `G/lib/triggers.ts`.

### 2.10 AI knowledge (`ai_knowledge`)

- **Purpose**: knowledge sources/items, extraction, retrieval, decisions,
  proposed replies, governance audit.
- **Key paths**: `G/lib/ai/knowledge/*` (`Extractor.ts`, `Retriever.ts`,
  `auditLog.ts`), `G/modules/ai-knowledge/public/v1/`,
  `G/app/settings/ai/actions.ts` (the admin surface; holds much data access).
- **Owns**: `AiKnowledgeItem`, `AiKnowledgeSource`, `AiKnowledgeSection`,
  `AiKnowledgeAuditLog`, `AiKnowledgeUsageLog`, `AiExtractionJob`,
  `AiRetrievalPolicy`, `AiDecisionLog`, `AiProposedReply`, `KnowledgeBaseEntry`.
- **Note**: retrieval uses prefilter + LLM rerank, no embeddings (stated in the
  `Retriever.ts` header).

### 2.11 Smaller contexts

| Context | What it actually is | Key paths |
|---|---|---|
| `avito_acquisition` | Avito lead intake: worker collects responses → webhook → contact + chat + message | `avito-worker/src/`, `G/app/api/webhooks/avito/route.ts`, `G/lib/leads/intake.ts`, `G/lib/avito/`, `G/app/api/avito/**`, `G/app/leads/` |
| `operations_observability` | Health, integrity report, retention, stability report, job registry | `G/lib/{health.ts,IntegrityChecker.ts,RetentionCleanup.ts,stability-check.ts,cron-health.ts,execution-lock.ts}`, `G/modules/operations-observability/public/v1/`, `G/app/monitoring/`, `G/app/api/health/` |
| `configuration` | Settings UI and config validation | `G/app/settings/**`, `G/lib/config-validator.ts`, `G/modules/configuration/public/v1/` |
| `analytics_reporting` | Dashboards; the module is three re-export files | `G/app/dashboard/actions.ts`, `G/app/team-overview/`, `G/app/analytics/` (stubs), `G/modules/analytics-reporting/public/` |
| `platform_shell` | Boot, layout, shared UI, cross-context orchestrators, Android shell | `G/instrumentation.ts`, `G/app/layout.tsx`, `G/components/`, `G/infrastructure/**`, `G/modules/platform-shell/`, `G/config/navigation-domains.ts`, `android/` |
| `edge_delivery` | nginx routing and TLS | `deploy/nginx/templates/*.template`, `deploy/nginx/nginx.conf` |

Cross-context orchestration lives in `platform_shell`, notably:
`G/modules/platform-shell/internal/contact-conversation-orchestrator.ts`,
`G/modules/platform-shell/public/v1/outbound-conversation-identity.ts`,
`G/modules/platform-shell/public/v1/outbox-runtime.ts`,
`G/modules/platform-shell/public/v1/yandex-fleet-reconciliation.ts`.

---

## 3. Data ownership map

Method: owner = base manifest **plus** manifest amendments. Writers/readers were
derived by scanning source for Prisma accessor calls and raw `INSERT/UPDATE/DELETE`
SQL, then reconciled with reading the code. Raw-SQL reads and `(prisma as any)`
accessors are under-counted by that scan; "none found" means none found by it.

Status legend (used only where a model is not plainly active and documented):
**A** confirmed active · **A-U** active but ownership undocumented in manifests or
amendments · **L** legacy / compatibility (table kept, no runtime code on main) ·
**?** unknown.

### 3.1 Messaging

| Model | Main writers | Main readers | Public contract | Cross-domain access observed |
|---|---|---|---|---|
| `Chat` | `G/modules/messaging/public/v1/legacy-prisma-*-adapter` (conversation family), `G/lib/ConversationWorkflowService.ts` (raw SQL), `G/lib/MessageService.ts` | `MessageService.listConversations`, routes, channel code | `upsertChannelConversationV1`, `createExternalConversationV1`, `ensureConversationContactLinkV1`, `channelConversationWorkflowV1`; read: `resolveConversationContactV1` (`ResolveConversationContactQuery.v1`) | Direct writes in `G/app/api/messages/send-media/route.ts`, `send-image/route.ts`, `G/app/messages/open/route.ts`. Direct reads from `G/app/tg-actions.ts`, `G/lib/whatsapp/WhatsAppService.ts`, `G/app/api/webhooks/*` |
| `Message` | `MessageService.send/retrySend/recoverStuckMessages`, messaging adapters, `G/lib/messageEvents.ts` (aiStatus) | `MessageService.listMessages`, AI pipeline, channel dedupe lookups | `createChannelMessageV1`, `upsertExternalMessageV1`, `receiveMessageV1`, `patchMessageDeliveryV1` | Direct writes in `G/app/api/messages/{send-media,send-image,delete}/route.ts` |
| `MessageAttachment` | attach-media adapters (v1, v2) | `G/app/api/attachments/[id]/route.ts` | `attachMessageMediaV1` / `V2` | Direct write in `send-media/route.ts` |
| `MessageEventLog` | `G/lib/messageEvents.ts` (insert), event-log adapter (claim/complete/fail) | the claim only | `claimMessageEventV1` | — |
| `HistoryImportJob` | history-import-job adapter (raw SQL) | `channel-sync-operations.ts` | `patchHistoryImportJobV1` | `G/app/api/import-jobs/[id]/route.ts` |
| `CommunicationTrigger` | communication-trigger adapter | `G/app/settings/triggers/actions.ts` | — | No evaluator found (C-34) |
| `GroupVisibility` | `G/app/api/groups/visibility/route.ts` | same route, `ChatList.tsx` | none | Writer is outside the module |

Duplicated sources of truth: `Chat.channel` vs `Message.channel`; three parallel
person links on Chat (`driverId`, `contactId`, `contactIdentityId`); delivery
state split between `Message.status` and `Message.metadata.*`; `Message.aiStatus`
vs `MessageEventLog.status`.

`Chat` public read path, Contact → conversations: `contactConversationsV1`
(`ContactConversationsQuery.v1`) via
`legacy-prisma-contact-conversations-query-adapter.ts` — one read of
`Chat.{id, channel, lastMessageAt, createdAt}` where `contactId` is the requested
id or its canonical survivor (Contacts `resolveContactLineageV1`) and
`chatType = 'private'`, ordered `lastMessageAt DESC NULLS LAST, createdAt DESC,
id ASC`, `take 51`. No `ContactPhone`, `ContactIdentity`, `Driver` or provider read.

### 3.2 Contacts

| Model | Main writers | Main readers | Public contract | Cross-domain access observed |
|---|---|---|---|---|
| `Contact` | `SafeContactResolutionExecutor`, `ContactService`, `yandex-link.ts`, merge adapter, contact adapters | contacts module, messaging, fleet, tasks UI | `resolveChannelContactOperationV1`, `mergeContactsV1`, `createFleetContactV1` | `G/app/api/contacts/[id]/route.ts` updates name/tags/notes directly, outside the ownership admission |
| `ContactPhone` | executor, `ContactService`, merge adapter | contacts, `G/instrumentation.ts` (temp-phone expiry) | `addPhoneToContactV1`, `markTemporaryContactPhoneV1`, `deactivateContactPhoneV1` | — |
| `ContactIdentity` | executor, `ContactService.attachPhoneToIdentity`, merge adapter, `G/lib/ReachabilityService.ts` | contacts, messaging, telegram | `attachContactIdentityV1`, `contactReachabilityV1` | — |
| `ContactMerge` | merge adapter (`recordMerge`) | contacts | `mergeContactsV1` | — |
| `ContactDriverProfileAudit` (**L**) | none found | none found | — | Table created by archived migration `20260712000000_multi_park_driver_profiles`; see C-28 |

Duplicated sources of truth: four driver links (`Contact.yandexDriverId`,
`Contact.mainDriverId`, `Driver.contactId`, `Chat.driverId`); `Driver.phone` vs
`ContactPhone.phone`; `Contact.primaryPhoneId` vs `ContactPhone.isPrimary`; names
on `Contact`, `ContactIdentity`, `Chat`, `Driver`; schema-less state in
`Contact.customFields` (phone evidence, identity conflicts, driver confirmations,
automation flags) and `ContactIdentity.metadata` (`providerAccountId`, aliases).

### 3.3 Channels

| Model | Owner | Main writers | Main readers | Notes |
|---|---|---|---|---|
| `TelegramConnection` | telegram | `G/app/tg-actions.ts` | tg-actions, `G/app/api/channels/*` | Holds `sessionString`, `apiId`, `apiHash` |
| `DriverTelegram` | telegram | driver-telegram and manual-link adapters; **direct** `prisma.driverTelegram.update` in `G/app/api/webhook/telegram/route.ts` | `G/app/api/webhooks/bot/route.ts`, `bot-link`, `bot-users` | `driverId` and `telegramId` each unique |
| `BotUserRegistry` | telegram | `legacy-prisma-bot-user-profile-adapter.ts` | `G/app/api/bot-users/route.ts` | — |
| `BotChatMessage` | telegram | `G/app/tg-bot-actions.ts`, `G/app/api/webhook/telegram/route.ts`, bot-chat-message adapter | bot UI | No unique key |
| `Bot`, `Survey`, `Question`, `User`, `Answer`, `AnalyticsEvent`, `Broadcast`, `BroadcastStat` | telegram | `tg-bot/src/**` | `tg-bot/src/**`, `tg-bot/tg-bot-frontend` | Declared in **both** `tg-bot/prisma/schema.prisma` and `gravity-mvp/prisma/schema.prisma`; tables created by Gravity `0_init`. No writer found for `Broadcast` / `BroadcastStat` |
| tg-bot SQLite `users`, `actions` | telegram (`actions`), fleet (`connection_requests`) per `architecture/contexts/v1/scoped-data-ownership.json` | `tg-bot/src/database.js` | tg-bot | Scene state and sync flag |
| `WhatsAppConnection` | whatsapp | `G/app/settings/integrations/whatsapp/whatsapp-actions.ts`, `WhatsAppService`, `G/app/api/whatsapp/delete/route.ts` | service, instrumentation | `sessionData` written, not read |
| `WhatsAppChat`, `WhatsAppMessage` | whatsapp | `WhatsAppService.ts`, whatsapp maintenance adapters | service, debug routes | Provider mirror |
| `WhatsAppChatRoster` (**?**) | whatsapp | none found (only deleted by a maintenance adapter) | `G/app/api/debug-db/wa-diag` | C-29 |
| `MaxConnection` | max | `G/app/max-actions.ts` | `G/app/api/channels/accounts/route.ts`, messages profiles | Configuration only; no bot transport on main |
| `DriverMax` (**L**) | max | none found | `gravity-mvp/scripts/migrate-contacts.ts` | Created by active migration `20260328000000_…` |
| `MaxPersonalSession` (**L**) | max | none found | none found | Same migration |
| 27 `Max*` models (**L**): `MaxRawTransport{Event,Processing,Cursor}`, `MaxInboundNormaliz{ationResult,edEvent}`, `MaxRoute{Conversation,IdentityBinding,Observation,Conflict}`, `MaxOutbound{Command,ShadowPlan,ConversationActor,CommandReservation,Dispatch,DispatchLane,DispatchAttempt,DispatchTransition,ReconciliationTask}`, `MaxProviderConfirmation{Evidence,Resolution,Decision,Cursor}`, `MaxShadow{ComparisonRun,ComparisonResult,SemanticDiff,ComparisonCursor}`, `MaxAccountSessionOwner` | none declared | none on main | none on main | See below |

**Status of the 27 `Max*` models.** They are not dead schema and not drift:

- Their creating SQL is in `architecture/migrations/v1/archive/pre-outbox/`
  (ten migrations `20260726162043_add_max_raw_transport_journal` …
  `20260728214000_add_max_outbound_shadow_plan`).
- `architecture/migrations/v1/production-migration-authority.json` records those
  migrations as `storage: "archive"`, `live_ledger.status: "FINISHED_ACTIVE"`,
  with provenance ref `feature/personal-max-text-canary-autonomous-20260728T211316Z`.
- The migration replay control requires zero Prisma datamodel diff between the
  replayed history and `schema.prisma`, so the models must stay in the schema.
- No code on main reads or writes them, and no manifest or amendment assigns an
  owner.

Classification: **LEGACY / COMPATIBILITY** — schema kept in parity with a
production database history whose code is not on main. Whether the tables hold
data is not knowable from the repository.

### 3.4 Calling

| Model | Main writers | Main readers | Notes |
|---|---|---|---|
| `Call` | `G/lib/freeswitch/EslClient.ts`, `G/lib/queue/{transcribe,analyze}Worker.ts`, `G/modules/calling/internal/ai-calls/*` adapters, `recording-ready-prisma-adapter.ts`, `G/app/api/ai-calls/mock/route.ts`, calling contact-merge adapter | `G/app/api/calls/**`, `G/app/calls/`, `G/lib/ai/knowledge/callTranscriptBuilder.ts`, contacts coordinator | `fsUuid` unique. AI lifecycle/finalization journals live in `Call.metadata` JSON |
| `AiCallMessage` | transcript adapter, mock route | calling | — |
| `AiCallEvent` | `G/lib/ai-call/event-emitter.js` via maintenance adapter | none found | Append-only |
| `AiCallScenario`, `AiCallProject` | `G/lib/ai-call/scenarios.ts` | `G/lib/ai-call/*`, calling | — |
| `AiProviderSetting` | `G/lib/ai-call/provider-settings.ts` (encrypted, `AI_CALL_ENC_KEY`) | `G/app/api/internal/ai-call-keys/route.ts`, `keys-status.ts` | Accessed through `(prisma as any)` |
| `AiAgentProfile`, `AiAgentConfig` | calling ai-agent adapters | calling, settings | Messaging AI settings housed in calling |
| `TelephonyAiConfig` | `G/lib/aiCallAnalysis/config.ts` | analyze worker | Analysis rubric |
| `AiCallCampaign`, `AiCallCampaignMember`, `AiCallCampaignAttempt`, `AiCallAdmissionControl`, `AiCallAdmissionLease`, `AiCallCampaignAuditEvent` | `G/modules/calling/internal/ai-calls/ai-call-campaign-prisma-adapter.ts` (raw SQL) | same | Owner `calling` via `architecture/migrations/v1/pending-source-migrations.json` and the campaign isolation amendments |

### 3.5 Fleet operations and compensation

| Model | Main writers | Main readers | Notes |
|---|---|---|---|
| `Driver` | reconciler adapter (`upsertObservation`), `G/app/drivers/actions.ts`, `G/app/api/monitoring/sync/route.ts`, fleet-check routes, `G/lib/scoring.ts`; raw SQL in `yandex-fleet-scraper` | very wide (tasks, messages, dashboard, webhooks, contacts) | **Three independent sync writers** (X-08) |
| `DriverDaySummary` | `YandexFleetService.syncTrips`, `G/app/drivers/actions.ts`, daily-activity adapter | dashboard, scoring, tasks | Unique `(driverId, date)` |
| `DriverEvent`, `DriverAttention` | `G/app/api/monitoring/**` routes, fleet adapters | monitoring UI | — |
| `DriverAction` | fleet adapter | none found | — |
| `CommunicationEvent` | `legacy-prisma-driver-communication-event-adapter.ts` | fleet | — |
| `ScoringThreshold` | scoring adapter, `G/app/drivers/` | settings, scoring | — |
| `SyncStatus` | `G/lib/yandexSync.ts` only | same | Sync lease row |
| `ApiConnection`, `ApiLog` | fleet adapters | fleet, bot/webhook routes, compensation | Yandex credentials |
| `DailyParkStats` | none found in `G/` (one script) | `G/app/dashboard/actions.ts` | C-29 |
| `Park`, `ParkConnection` (**A-U**) | none found on main | `G/modules/fleet-operations/public/v1/yandex-connection-capability.ts`, `COMP/legacy-prisma-cash-order-ingestion-adapter.ts` | Created by archived migrations `20260712000000_…`, `20260713000000_stable_park_identity`. No manifest/amendment owner; no writer or UI |
| 10 compensation core models: `CompensationBudgetPeriod`, `CompensationPerson`, `CompensationPersonBinding`, `CompensationVerifiedOrder`, `CompensationOrderClaim`, `CompensationApplication`, `CompensationPayoutAuthorization`, `CompensationSettlement`, `CompensationReconciliationTask`, `CompensationAuditEvent` | `COMP/compensation-prisma-adapter.ts`; budget period also `legacy-prisma-compensation-budget-period-adapter.ts` | manager and pilot adapters | Owner `fleet_operations` via `architecture/isolation/fleet-operations/compensation-monetary-core-v1/module-manifest-amendments.json` |
| `CompensationCashOrder`, `CompensationCashOrderIngestionCheckpoint`, `CompensationPilotSubmission` | ingestion adapter; pilot adapter | compensation | Owner via `…/compensation-pilot-v1/module-manifest-amendments.json` |
| scraper SQLite `Account`, `Check`, `CheckResult`, `AuditLog` | `yandex-fleet-scraper/src/{api,worker}.ts` | same | `AuditLog` has no writer |

Compensation reads `Contact`, `ContactPhone`, `ApiConnection`, `Driver` without
owning them.

### 3.6 Identity, work, AI knowledge, operations, avito, shared

| Model | Owner | Main writers | Main readers | Notes |
|---|---|---|---|---|
| `CrmUser` (`crm_users`) | identity_access | `legacy-prisma-crm-user-seed-adapter.js` | `G/app/tasks/*`, `G/app/team-overview/actions.ts` | Not the login store; no link to `users.json` |
| `MobileDeviceRegistration` | identity_access (amendment) | `prisma-mobile-device-registration-adapter.ts` | same | Unique `deviceId`, unique `fcmToken` |
| `Task`, `TaskEvent` | work_management | `G/app/tasks/{actions,excel-actions}.ts`, `G/lib/triggers.ts`, `G/lib/tasks/*`, work-management adapters | tasks, my-day, team-overview | — |
| `ManagerTask` | work_management | `legacy-prisma-completion-adapter.ts` | `G/app/inbox/actions.ts` | No creator found in `G/` |
| `scenario_field_settings`, `usage_events` | work_management | work-management adapter; `G/lib/tasks/usage.ts` (raw SQL) | — | — |
| `AiKnowledgeItem`, `AiKnowledgeSource`, `AiExtractionJob`, `AiDecisionLog`, `AiKnowledgeUsageLog`, `AiRetrievalPolicy`, `AiKnowledgeAuditLog` | ai_knowledge | raw SQL in `G/lib/ai/knowledge/*` and ai-knowledge adapters | retrieval, settings | — |
| `AiKnowledgeSection`, `KnowledgeBaseEntry`, `AiProposedReply` | ai_knowledge | ai-knowledge adapters | `G/app/messages/*` | `AiProposedReply.messageId` unique |
| `cron_health_log`, `integrity_check_log`, `stability_check_log`, `perf_log`, `config_change_log` | ops / configuration | raw SQL in the matching `G/lib/*.ts`; tables also created with `CREATE TABLE IF NOT EXISTS` at runtime | system-health UI | `perf_log`, `config_change_log`: no caller of their writers found |
| `execution_lock` | ops | `G/lib/execution-lock.ts` | stability/guardrails | No caller of the lock functions (C-14) |
| `health_snapshots`, `health_score_history`, `intervention_actions` | ops | ops adapters, called from `G/app/team-overview/actions.ts` | team-overview | — |
| `avito_accounts`, `avito_app_settings`, `avito_jobs`, `avito_activity_log`, `avito_responses` | avito | `G/app/api/avito/**`, `G/lib/avito/helpers.ts`, `G/app/api/webhooks/avito/route.ts`, `G/app/api/leads/*` | same | — |
| `avito_crm_outbox_events`, `avito_phone_reveal_attempts`, `avito_account_snapshot`, `avito_auth_users`, `avito_auth_sessions` | avito | not written by Gravity; `avito-worker` writes through its own Drizzle schema (`avito-worker/_shared/db`) | worker | Two schema definitions for the same tables |
| `DomainOutboxEvent` (`domain_outbox_events`) | shared infrastructure (`architecture/events/v1/module-manifest-amendments.json`) | producers: messaging inbound adapters, mobile-push fan-out, calling adapters; state: `G/infrastructure/outbox/prisma-outbox-store.ts` | the store | — |

Entry count: all 135 Gravity Prisma models are named above, plus 7 non-Gravity
stores (4 scraper SQLite models, 2 tg-bot SQLite tables, raw `usage_events`).

---

## 4. Critical flows

Format: `entrypoint → service → contract → persistence → downstream`.

### Contacts

**F-01 Contact resolution on inbound** (all channels)
`<channel inbound code>` → `resolveChannelContactOperationV1`
(`G/modules/contacts/public/v1/contact-identity-maintenance.ts`) →
`ContactService.resolveContact` (`G/lib/ContactService.ts`) →
`SafeContactResolutionExecutor.execute` → ownership transaction
(`G/modules/contacts/internal/contact-ownership-coordinator.ts`) →
`ContactResolutionService.resolve` (plan) → create/reuse `Contact`,
`ContactPhone`, `ContactIdentity` → postcondition asserts. Caller then runs
`ensureConversationContactLinkV1` (messaging) and
`contactReachabilityV1.recordExactProviderReachability`.
Call sites: `G/app/api/webhook/telegram/route.ts`, `G/app/tg-actions.ts`,
`G/app/api/webhooks/max/route.ts`, `G/lib/whatsapp/WhatsAppService.ts`,
`G/lib/leads/intake.ts`; calls use `resolveContactByPhoneV1` from
`G/lib/freeswitch/EslClient.ts`.

**F-02 Contact merge**
Manual: `ContactProfileDrawer` → `POST /api/contacts/[id]/merge-to/[targetId]` →
`ContactMergeService.mergeContactToContact` → `mergeContactsV1`
(`G/infrastructure/contact-merge-composition.ts`) → `contact-merge-handler.ts`:
admit → ordered pair lock → survivor evaluation → move identities/phones →
per-owner adapters move chats, tasks, calls, driver profiles → `recordMerge` →
archive loser → postconditions.
Automatic: `executeAutomaticContactMergeV1`
(`G/infrastructure/automatic-contact-merge.ts`), triggered from
`G/app/api/contacts/[id]/parks/route.ts`, `…/driver-person/route.ts` and the fleet
reconciliation runner — not from inbound resolution.

**F-03 Contact ↔ driver linking**
Canonical: `POST /api/contacts/[id]/driver-person` → `confirmDriverPersonV1` →
optional auto-merge → fleet reconciliation.
Legacy phone link: `G/app/drivers/actions.ts` → `linkContactToBestDriverV1` →
`G/lib/contacts/yandex-link.ts`.
Fleet sync: reconciler adapter → `runDriverClusterContactOwnershipV1`.

### Messaging and channels

**F-04 Telegram MTProto inbound**
`G/instrumentation.ts` → `initializeOperationalTelegramRuntimeV1` →
`initTelegramListeners` (`G/app/tg-actions.ts`) → `NewMessage` handler →
`processInboundTelegramMessage` → `admitTelegramPrivateConversation`
(`upsertChannelConversationV1`, `externalChatId = telegram:<peerId>`) → F-01 →
`createChannelMessageV1` (`externalId = telegram:<account>:<peer>:<msgId>`) →
`attachMessageMediaV1` → `channelConversationWorkflowV1.onInboundMessage` →
`publishPersistedMessageV1`.

**F-05 Telegram bot inbound**
`tg-bot/src/bot.js` (first middleware: awaits the forward to a terminal outcome
before any handler runs) → `tg-bot/src/services/crmIntegration.js` (header
`x-bot-signature`; bounded retry on 5xx and transport errors, 4xx is terminal) →
`POST G/app/api/webhook/telegram/route.ts` → auth → exact provider-event check →
conversation admission → dedupe on `(chatId, externalId)` → **persist**:
`prisma.botChatMessage.create` → `createChannelMessageV1` → conversation
workflow → **enrich** (bounded, non-fatal): F-01 → `recordBotUserProfileV1`.
A blocked enrichment is answered `processed: 'message_persisted'`,
`enrichment: 'blocked'`, never as a retryable error; only a failed persist
answers 500. The same route also runs the driver limit-change state machine.
This route does **not** call `publishPersistedMessageV1` (R-06).

**F-06 Telegram driver linking**
tg-bot `handlers/start.js` → action `sync_user` →
`G/app/api/webhooks/bot/route.ts` → `recordBotUserProfileV1` + pending link
request → manager confirms via `POST G/app/api/bot-link/route.ts` →
`saveManualDriverTelegramLinkV1` → authority → transactional `DriverTelegram`
write. Alternative entry: `G/app/api/platform/drivers/[id]/telegram-link/route.ts`.
The authority (`manual-driver-telegram-link-authority.ts`) is two separate
proofs: a transport-free person proof,
`prepareDriverTelegramConversationAuthorityV1` (exact private `Chat` by
`chatType`, active confirmed conflict-free `ContactIdentity`, confirmed main
Driver), and the configured Bot transport
(`canonicalTelegramBotConnectionIdV1()`). It is re-read inside the write
transaction under the Contacts ownership lock. Driver actions arriving through
`G/app/api/webhooks/bot/route.ts` use the same person proof and prove the
calling Bot transport against configuration, not against `Chat` metadata.
On the bot page (`G/app/settings/integrations/bot/BotPageClient.tsx`) a person
the authority does not yet accept is confirmed through F-03, not in this flow:
`G/app/api/bot-users/route.ts` exposes the pending chat's Contact
(`chatContactId`), the page calls `POST /api/contacts/[id]/driver-person` on it,
waits for the refreshed search, then links. `bot-link` accepts a Driver for the
selected Yandex profile by its legacy raw profile id or by the park-qualified
pair (`externalDriverProfileId` + `externalParkId`); anything else is
`DRIVER_PROFILE_UNVERIFIED`. Authority refusals reach the operator as fixed
codes (`PERSON_CONFIRMATION_REQUIRED` and the `TELEGRAM_*` family).

**F-07 MAX inbound**
`max-web-scraper/transport/TransportInterceptor.js` (WS frame) → `handleIncoming`
(`max-web-scraper/index.js`) → `MessageSync.isDuplicate` →
`MessageParser.toCrmPayload` → `forwardToWebhook` (adds `accountId`, `chatKind`,
header `x-max-scraper-webhook-secret`) →
`POST G/app/api/webhooks/max/route.ts` → `isAuthorizedMaxScraperWebhookV1` →
collision checks → `createExternalConversationV1` / `patchExternalConversationV1`
→ `upsertExternalMessageV1` → `attachMessageMediaV2` →
`ConversationWorkflowService.onInboundMessage` → F-01 → SSE broadcast +
`publishPersistedMessageV1`.

**F-08 WhatsApp inbound**
`client.on('message')` in `G/lib/whatsapp/WhatsAppService.ts` → instance/filter
checks → `assertPrivateWhatsAppConversationConnectionV1` →
`prisma.whatsAppChat.upsert` → `upsertChannelConversationV1` → F-01 (with
`canonicalWhatsAppIdentityExternalIdV1`) → `DriverMatchService.linkChatToDriver` →
`prisma.whatsAppMessage.upsert` → `createChannelMessageV1`
(`externalId = msg.id._serialized`) → `attachMessageMediaV1` → workflow →
`publishPersistedMessageV1`.

**F-09 Operator outbound text**
`G/app/messages/hooks/useMessages.ts` (generates `clientMessageId`) →
`POST G/app/api/messages/route.ts` → `MessageService.send` → idempotency lookup on
`clientMessageId` → `prepareOutboundConversationV1` (port bound in
`G/instrumentation.ts` to
`G/modules/platform-shell/public/v1/outbound-conversation-identity.ts`) →
`prisma.message.create` (status `sent`) → SSE → `switch(channel)` →
`get{WhatsApp,Telegram,Max}ChannelDeliveryV1().sendText` → `message.update`
(status, `externalId`, metadata) → SSE → `ConversationWorkflowService.onOutboundMessage`
→ reachability record.
MAX leg: `sendMaxTransportTextV1`
(`G/modules/max-channel/application/messaging-transport.ts`) → scraper
`POST /send-message` → result validated by `validateMaxTextDeliveryResultV1`.

**F-10 Routing / "send to contact"**
There is no channel router: the channel is `Chat.channel`, and a channel override
that differs from it is rejected. Sending to a contact means opening the right
Chat first: `POST /api/contacts/[id]/chats` or
`POST /api/contacts/start-conversation` →
`G/modules/platform-shell/internal/contact-conversation-orchestrator.ts`.

**F-11 Media, reaction, delete**
`G/app/api/messages/{send-media,reaction,delete}/route.ts` call the provider
capability first and persist afterwards, with direct Prisma writes.

**F-12 Delivery retry and recovery** (intervals in `G/instrumentation.ts`)
- every 5 min + at boot: `recoverStuckMessagingDeliveriesV1` →
  `MessageService.recoverStuckMessages(5)` — outbound rows still `sent` with no
  `externalId` after 5 min become `failed`, outcome `unknown`.
- every 2 min: `retryEligibleMessagingDeliveriesV1` → `MessageService.retrySend`.
  The selector admits only `failed` outbound rows recorded `safe_to_redeliver`
  with `errorSchemaVersion` ≥ 2 (I-10); `retrySend` re-checks that gate, leases the
  row (compare-and-set on `failed` + `updatedAt`, `retryLeaseId`), and only the
  lease holder may finalise it (I-11).
- operator: `G/app/messages/message-retry-actions.ts` → `retrySend({operatorInitiated})`.

**F-13 Realtime**
`G/lib/messageStreamBus.ts` (in-process map) →
`GET G/app/api/messages/stream/[chatId]/route.ts` (SSE) → `useMessages`
(`EventSource` + 30 s poll).

**F-14 AI reply and drafts**
Auto: `emitMessageReceived` (`G/lib/messageEvents.ts`) → `PipelineWorker.process`
(`G/modules/messaging/internal/ai-reply-pipeline/`) → `claimMessageEventV1` →
`ContextBuilder` → `IntentClassifier` → `DecisionEngine` → `ResponseGenerator` →
`ChannelAdapterRegistry.send` → `recordAiDecisionV1`.
Draft: `G/app/messages/proposed-reply-actions.ts` → `upsertProposedReplyV1`.

**F-15 Outbox dispatch**
`startDomainOutboxPublisherV1`
(`G/modules/platform-shell/public/v1/outbox-runtime.ts`, 2 s poll) →
`G/infrastructure/outbox/v1/outbox-publisher.ts` →
`G/infrastructure/outbox/prisma-outbox-store.ts` (claim, stale recovery) →
publishers `messagingOutboxPublishersV1`, `callingOutboxPublishersV1`.

**F-16 Mobile push for a message**
inbound adapter writes `Message` + outbox event `InboundMessageNotificationRequested`
in one transaction → outbox → fan-out per eligible device
(`G/modules/messaging/internal/mobile-push/`) → identity_access FCM transport
(`G/modules/identity-access/internal/mobile-delivery/fcm-http-v1-transport.ts`) →
Android `PushMessagingService` → `PushPayload.parse` → notification → deep link
`/messages/open`.
Device registration: Android `PushRegistrar` →
`POST /api/mobile/push-registration` → `registerMobilePushDeviceFromSessionV1`.

### Calling

**F-17 Manager outbound call**
`CallButton.tsx` → `POST G/app/api/calls/originate/route.ts` → `originateCall()`
(`EslClient.ts`, ESL `bgapi originate`) → browser JsSIP auto-answers the bridged
leg (`sip-client-context.tsx`) → ESL `CHANNEL_CREATE` → `resolveContactByPhoneV1`
+ `prisma.call.upsert({where:{fsUuid}})` → `CHANNEL_ANSWER` → SSE via
`G/modules/calling/internal/call-stream.ts`.

**F-18 Inbound call and alerts**
SIP trunk → `telephony/conf/dialplan/public/00_inbound_did.xml` →
`default/02_megafon_inbound.xml` (ring group 101–103, recording) → ESL
`handleChannelCreate` → `Call` row `ringing` → SSE → `IncomingCallPopup` →
`recordCallStateTransitionV1` → outbox `CallAlertRequested` → per-device fan-out →
FCM. Missed-call alerts come from hangup / `reconcileStaleCalls`.

**F-19 Recording → transcription → analysis**
FreeSWITCH `record_session` → hangup → `processRecording()`
(`recordingProcessor.ts`: ffmpeg → S3) → `persistRecordingReadyV1` (path + outbox
`RecordingReady.v1`, one transaction) → outbox → `enqueueTranscribe` →
`transcribeWorker.ts` (Whisper) → `enqueueAnalyze` → `analyzeWorker.ts`.

**F-20 Controlled AI call**
`POST G/app/api/ai-calls/start/route.ts` (role + operator token + readiness +
allowlisted destination) → `claimControlledRealAiCall` (`Call` row with
deterministic ids) → `originateAiCall` (`G/lib/ai-call/esl-originate.ts`) →
dialplan `telephony/conf/dialplan/default/99_audio_fork_test.xml` (ext 9999) →
audio bridge (`tools/audio-bridge-day1/`): STT → LLM → TTS loop → callbacks to
`G/app/api/ai-calls/sessions/[id]/{state,transcript-item,finalize}` (header
`X-Bridge-Token`) → `finalizeAiCall` → `createIdempotentTaskV1`.
Timeline projection into the chat comes from Gravity's own ESL hangup handler
(`syncCallToChat` → messaging projector), not from finalization.

**F-21 AI-call campaigns**
`G/app/api/ai-calls/campaigns/**` → `aiCallCampaignManagementV1` → worker
(`G/modules/calling/application/ai-call-campaign-runtime.ts`): claim launch →
admission (global row lock) → dial port → attempt result. The only dial adapter
on main is the simulated one; live mode does not start.

### Cash compensation

**F-22 Cash-order ingestion**
`G/instrumentation.ts` (interval, only when `YOKO_CASH_ORDER_INGESTION_MODE` is
not `off`) → `runScheduledCashOrderIngestionV1` → `CashOrderIngestionRuntimeV1` →
Yandex Fleet orders API → `CompensationCashOrder` upserts + checkpoint lease.

**F-23 Driver submission**
tg-bot scene (`tg-bot/src/handlers/compensation.js`) →
`POST G/app/api/webhooks/bot/route.ts` (`compensation_*` actions) →
`compensationPilotSubmitV1` → `submitPilotApplicationV1`
(`COMP/compensation-pilot-service.ts`) → `submitCompensationApplicationV1`
(`COMP/compensation-prisma-adapter.ts`: row locks; writes verified order, claim,
application, reservation, audit event) + `CompensationPilotSubmission`.

**F-24 Manager actions**
`G/app/compensation/actions.ts` → session principal → (approve: evidence file must
be fetched) → `compensationManagerActionV1` → `performManagerActionV1`
(`COMP/compensation-manager-service.ts`) → start payout / finalize (settlement) /
release / reject / resolve reconciliation in the adapter.
Budget control: `gravity-mvp/scripts/compensation-budget-period.ts`.

### Authentication and authorization

**F-25 Request authorization** — four separate mechanisms:

| Lane | Mechanism | Where enforced |
|---|---|---|
| Browser operator | Cookie `crm_user_id` chosen on `/login` from `G/data/users.json`; unsigned, no password. `canLogin` only stops a Менеджер from switching identity. The code calls this "not a real authentication primitive" | `G/lib/users/user-service.ts`. `G/proxy.ts` does not check it |
| Mobile shell (User-Agent contains `YokoShell/`) | Signed `yoko_mobile_session` cookie (12 h, revocation epoch) from shared `MOBILE_ACCESS_USER/PASS` | `G/proxy.ts`, `mobile-session-auth.ts` |
| Integration admin | `ADMIN_USER/ADMIN_PASS` → HMAC cookie `yoko_integration_admin_session` (8 h) | `requireIntegrationAdminAccess` in settings pages/actions and selected API routes |
| Machine callers | Shared secrets per caller (below) | The individual route |

Machine secrets: `BOT_CRM_SECRET` (`x-bot-signature`; bot webhooks, fails closed),
`MAX_SCRAPER_WEBHOOK_SECRET` (timing-safe, fails closed), `BRIDGE_SHARED_TOKEN`
(`X-Bridge-Token`; bridge callbacks, fails closed), `AI_CALL_CONTROLLED_OPERATOR_TOKEN`,
`AVITO_WEBHOOK_TOKEN` (Bearer; accepts everything when unset), `CRON_SECRET`
(only `G/app/api/cron/sync-scraper/route.ts` and `G/app/api/monitoring/sync/route.ts`;
accepts everything when unset).

`G/proxy.ts` additionally returns 404 for `/api/debug-db*`. The nginx template
adds Basic Auth on `/compensation` and a 404 on `/api/debug-db`. What other
perimeter protects the browser lane in production is not visible in the
repository.

### Fleet, work, operations

**F-26 Scheduled Yandex Fleet sync**
`G/instrumentation.ts` (hourly tick, runs at local hour 3) →
`runScheduledYandexSyncV1` → `runYandexSync` (`G/lib/yandexSync.ts`, lease on
`SyncStatus`) → registered runner `reconcileYandexFleetWithAutomaticMergeV1` →
reconciler adapter: fetch park profiles → `upsertObservation` (`Driver`) → cluster
reconcile with contacts → optional automatic merge →
`YandexFleetService.syncTrips` → `DriverDaySummary` → segment recalculation.
Also reachable via `GET /api/cron/sync-trips` and the drivers UI.

**F-27 Scraper check**
`POST G/app/api/monitoring/drivers/[id]/fleet-check/route.ts` (row lock on
`Driver`) → `POST {scraper}/api/checks` (`yandex-fleet-scraper/src/api.ts`,
idempotency key = BullMQ `jobId`) → `worker.ts` (Playwright) → `fireWebhook` to
`CRM_WEBHOOK_URL` → `POST G/app/api/monitoring/fleet-check/callback/route.ts` →
`Driver` + `DriverEvent`.

**F-28 Task creation**
Manual / from a message: `createTask` (`G/app/tasks/actions.ts`) → `task.create`
+ `logTaskEvent('created')`.
From an AI call: `createIdempotentTaskV1` (deterministic id).
Bulk: `POST /api/tasks/bulk-care`. Excel: `G/app/tasks/excel-actions.ts`.
`G/lib/triggers.ts` closes, escalates and annotates tasks; it does not create them.

**F-29 Boot and scheduled jobs** (`G/instrumentation.ts`, `register()`)
Boot order: proxy init → env warnings → register WhatsApp/Telegram/MAX delivery
capabilities → register outbound conversation preparer → register fleet
reconciliation runner → (after 5 s) config validation, DB connect, Telegram
runtime, WhatsApp cleanup + warm-up, stuck-delivery recovery → intervals → ESL
listener + call-timeline projector → call workers → outbox publisher → Yandex
sync tick → cash-order ingestion → shutdown handlers.

| In-process job (`runOperationalJobV1` name) | Cadence |
|---|---|
| `recovery` | 5 min |
| `integrity` | 30 min |
| `message_retry` | 2 min |
| `wa_watchdog` | 60 s |
| `temp_phone_expire` | 1 h |
| `retention_cleanup` | 24 h |
| `stability_check` | 24 h |
| AI-call campaign runtime | set by calling |
| domain outbox publisher | 2 s |
| `yandex_fleet_sync` | hourly tick, acts at 03:00 local |
| `compensation_cash_order_ingestion` | when enabled |

The only overlap guard is the per-process flag in `runOperationalJobV1`.
HTTP routes under `G/app/api/cron/*` (`auto-close-tasks`, `enforce-followup`,
`escalations`, `init-telegram`, `pattern-alerts`, `sla-escalation`,
`stability-check`, `sync-scraper`, `sync-trips`) are **not** called by anything in
the repository.

**F-30 AI knowledge extraction**
`startKnowledgeExtraction` (`G/app/settings/ai/actions.ts`) →
`queueKnowledgeExtractionV1` (`AiExtractionJob`) → in-process `runExtraction` →
`G/lib/ai/knowledge/Extractor.ts` (LLM batches → `AiKnowledgeItem`,
`AiKnowledgeSource`) → retrieval via
`G/modules/ai-knowledge/public/v1/knowledge-retrieval.ts`.

**F-31 Avito lead intake**
`avito-worker/src/jobs/handlers/collect-responses.handler.ts` →
`avito_crm_outbox_events` + POST → `G/app/api/webhooks/avito/route.ts` →
`ingestLead` (`G/lib/leads/intake.ts`) → F-01 (channel `avito`) →
`markTemporaryContactPhoneV1` → `ensureLeadConversationV1` → `receiveMessageV1`.

**F-32 Retention and integrity**
`RetentionCleanup.runAll` (`G/lib/RetentionCleanup.ts`): batched deletion of old
messages, driver/communication events, API logs and long-archived contacts,
through owner contracts. `IntegrityChecker.runAll`: seven read-only checks, one
report row; it repairs nothing.

---

## 5. Change routing matrix

| If you need to change | Owning domain | Start reading here | Public extension point | Mandatory checks | Do not touch directly |
|---|---|---|---|---|---|
| Contact lookup / search | contacts | `G/app/api/contacts/search/route.ts`, `G/app/messages/hooks/useContactSearch.ts` | The route itself (no port exists) | route tests under `G/app/api/contacts/` | Messaging tables |
| Contact resolution rules | contacts | `G/lib/contacts/ContactResolutionService.ts`, `SafeContactResolutionExecutor.ts` | `resolveChannelContactOperationV1` | `G/lib/__tests__/contact-resolution-*.test.ts`, executor postgres test | Channel code; do not bypass the ownership coordinator |
| Phone normalisation | contacts | `G/modules/contacts/public/v1/phone-identity.ts` | `normalizePhoneE164` | `phone-identity.test.ts` | The ad-hoc normalisers listed in C-19 (do not add another) |
| Contact merge | contacts | `G/modules/contacts/public/v1/contact-merge-handler.ts`, `G/infrastructure/contact-merge-composition.ts` | `mergeContactsV1`; per-owner `legacy-prisma-contact-merge-adapter.ts` | `contact-merge-handler.test.ts`, `contact-automation-policy.test.ts` | Other contexts' tables except through their merge adapters |
| Contact card UI | contacts / messaging UI | `G/app/messages/components/ContactProfileDrawer.tsx`, `G/app/api/contacts/[id]/route.ts` | — | route tests; manual UI check | — |
| Outbound text send | messaging | `G/lib/MessageService.ts` (`send`, `retrySend`) | `SendIntentV1` + delivery port in `channel-delivery-runtime.ts` | `G/lib/MessageService.provider-account.test.ts`, `operator-delivery-retry.test.ts` | Provider SDKs; a new send option must also enter `assertSameSendIntent` |
| Media / reaction / delete send | messaging | `G/app/api/messages/{send-media,reaction,delete}/route.ts` | channel delivery capability methods | route tests | — |
| Inbound persistence | messaging | `G/modules/messaging/application/messaging-operations.ts` | `createChannelMessageV1`, `upsertExternalMessageV1`, `receiveMessageV1` | `tools/architecture/test-messaging-*.mjs`, module tests | `prisma.message.*` from channel code |
| Conversation status / unread | messaging | `G/lib/ConversationWorkflowService.ts` | `channelConversationWorkflowV1` | facade test only (gap G-07) | Raw `Chat` updates elsewhere |
| Open a chat for a contact | platform_shell | `G/modules/platform-shell/internal/contact-conversation-orchestrator.ts` | `openContactConversationForContactV1`, `startContactConversationByPhoneV1` | `check-contact-conversation-api-boundary.mjs` | — |
| AI auto-reply | messaging (+ ai_knowledge) | `G/modules/messaging/internal/ai-reply-pipeline/` | `DecisionEngine`, `ChannelAdapterRegistry` | `check-messaging-ai-reply-pipeline-boundary.mjs` | ai_knowledge tables |
| Telegram MTProto behaviour | telegram | `G/app/tg-actions.ts` | `TelegramChannelDeliveryV1`, `runtime-operations.ts` | `G/app/tg-actions.identity.test.ts`, `check-telegram-runtime-provider-boundary.mjs` | `Chat`/`Message` directly |
| Telegram bot inbound / bot actions | telegram | `G/app/api/webhook/telegram/route.ts`, `G/app/api/webhooks/bot/route.ts`, `tg-bot/src/handlers/` | new `case` + tg-bot handler via `tg-bot/src/services/crmAction.js` | route tests; `tg-bot` `npm run test:security-boundaries` | — |
| Driver ↔ Telegram link | telegram | `G/modules/telegram-channel/public/v1/manual-driver-telegram-link-*` | `saveManualDriverTelegramLinkV1` | `check-telegram-driver-link-boundary.mjs`, link adapter tests | `DriverTelegram` direct writes |
| WhatsApp | whatsapp | `G/lib/whatsapp/WhatsAppService.ts` | `WhatsAppChannelDeliveryV1`, `runtime-operations.ts` | `WhatsAppService.connection-binding.test.ts`, `check-whatsapp-runtime-provider-boundary.mjs` | The three ingest paths must stay consistent (X-04) |
| MAX inbound | max | `G/app/api/webhooks/max/route.ts`, `max-web-scraper/index.js` (`handleIncoming`) | webhook payload fields | `G/app/api/webhooks/max/route.test.ts` | — |
| MAX outbound | max | `G/modules/max-channel/public/v1/messaging-delivery-capability.ts`, `application/messaging-transport.ts`, scraper `/send-message` | `MaxChannelDeliveryV1` | `gravity-mvp/test/max-*.test.ts`; `node --test max-web-scraper/test/*.test.js` (manual) | `Max*` legacy models |
| Human calling | calling | `G/lib/freeswitch/EslClient.ts`, `G/modules/calling/public/v1/sip-client-context.tsx`, `telephony/conf/dialplan/` | — | `G/app/api/calls/**` tests, `telephony/tests/` | Extension map is hardcoded in `G/lib/sip/extensions.ts` and the dialplan together |
| Call alerts | calling (+ identity_access transport) | `G/modules/calling/internal/call-alerts/`, `application/call-alert-operations.ts` | `callingOutboxPublishersV1` | `call-alert-transition.test.ts`, `call-alert-dispatch.test.ts` | FCM transport internals |
| Recording / transcription / analysis | calling | `G/lib/freeswitch/recordingProcessor.ts`, `G/lib/queue/` | outbox `RecordingReady.v1` | `outbox-consumers.test.ts` | — |
| AI call | calling | `G/modules/calling/application/ai-call-*.ts`, `tools/audio-bridge-day1/` | lifecycle / finalization persistence ports | `ai-call-lifecycle.test.ts`, `ai-call-finalization.test.ts`, bridge `npm test` | `Task` (use `createIdempotentTaskV1`) |
| AI-call campaigns | calling | `G/modules/calling/application/ai-call-campaign-runtime.ts`, `internal/ai-calls/ai-call-campaign-prisma-adapter.ts` | `AiCallCampaignDialPort` | `ai-call-campaign*.test.ts` (postgres) | — |
| Cash compensation money rules | fleet_operations | `COMP/compensation-policy.ts`, `compensation-prisma-adapter.ts`, migration `20260910220000_add_compensation_monetary_core` | compensation ports | `npm run test:compensation-proofs` | Contact tables (lock order forbids locking them) |
| Cash-order ingestion | fleet_operations | `COMP/cash-order-ingestion-runtime.ts` | `CashOrderIngestionPortsV1` | ingestion tests in `COMP/` | — |
| Compensation manager UI | fleet_operations | `G/app/compensation/` | `compensationManagerActionV1` | `G/app/compensation/manager-actions.test.ts`, `check-compensation-edge-perimeter-boundary.mjs` | nginx gate without the perimeter doc |
| Android / push | platform_shell (app), identity_access (server) | `android/app/src/main/java/ru/yokoone/crm/shell/`, `G/modules/identity-access/internal/mobile-delivery/` | `PushPayload` kinds; FCM transport | Gradle unit tasks; `check-mobile-delivery-provider-boundary.mjs` | — |
| Login / sessions / guards | identity_access | `G/lib/users/user-service.ts`, `G/proxy.ts`, `G/modules/identity-access/public/v1/` | `IdentityAccessPortV1` | `npm run test:security-boundaries` | — |
| Yandex Fleet sync | fleet_operations | `G/lib/yandexSync.ts`, reconciler adapter | `registerYandexFleetReconciliationRunnerV1` | `yandex-sync-lease.test.ts`, reconciler tests | `Contact*` (use contacts contracts) |
| Scraper checks | fleet_operations | `G/app/api/monitoring/**`, `yandex-fleet-scraper/src/` | new job branch in `worker.ts` | `yandex-fleet-scraper` `npm test` | — |
| Tasks | work_management | `G/app/tasks/actions.ts`, `G/lib/tasks/` | `createIdempotentTaskV1` for other contexts | module tests | `Task` writes from other contexts |
| Background job | owner + platform_shell | `G/instrumentation.ts` | `runOperationalJobV1(name, fn)` | `check-operations-operational-job-registry-boundary.mjs` | — |
| AI knowledge | ai_knowledge | `G/lib/ai/knowledge/`, `G/app/settings/ai/actions.ts` | ai-knowledge `public/v1` | `check-ai-knowledge-*-boundary.mjs` | — |
| Avito leads | avito | `G/lib/leads/intake.ts`, `G/app/api/webhooks/avito/route.ts`, `avito-worker/src/` | `LeadSource` in `G/lib/leads/types.ts` | `G/lib/leads/intake.test.ts` | — |
| Prisma schema / migration | owning context | §6.3 | pending-source row | §6.3 | `architecture/migrations/v1/archive/` |
| Public contract / new capability | owning context | `G/contracts/<ctx>/`, `architecture/contracts/v1/README.md` | add `vN+1` beside the old version | `validate-contract-registry.mjs`, `check-contract-boundaries.mjs` | Editing a `v1` in place |
| Docker / compose / nginx | edge_delivery / platform | `deploy/` | — | registry rebinds; runtime check on a host | — |
| Architecture control | governance | `tools/architecture/run-authoritative-ci.mjs` | — | `test-authoritative-ci-inventory.mjs` | Weakening or skipping a control |

---

## 6. Verification routing map

### 6.1 What exists

| Test family | Location | Command | Needs |
|---|---|---|---|
| Gravity vitest (282 `*.test.ts(x)`) | colocated in `gravity-mvp/src/**`, `gravity-mvp/test/` | `npm test` (in `gravity-mvp`), or `npx vitest run <files>` | 22 `*.postgres.test.ts` skip unless their own DB env var is set |
| Gravity security subset | 9 files + `gravity-mvp/scripts/check-public-boundaries.mjs` | `npm run test:security-boundaries` | — |
| Compensation proofs | `COMP/` | `npm run test:compensation-proofs` | Postgres for the postgres tests |
| Architecture controls | `tools/architecture/` | `node tools/architecture/<control>.mjs`; full suite via `run-authoritative-ci.mjs` | Node 20.20.2; replay controls need Postgres |
| tg-bot | `tg-bot/src/{security,services,handlers}` | `npm run test:security-boundaries`, `npm run test:services` | — |
| max-web-scraper | `max-web-scraper/test/` (node:test + python source tests) | `node --test max-web-scraper/test/*.test.js` | Manual only; `package.json` `test` is a stub |
| yandex-fleet-scraper | `yandex-fleet-scraper/src/lib/order-locator.test.ts` | `npm test` (jest) | — |
| Audio bridge | `tools/audio-bridge-day1/__tests__` (14 files) | `npm test` runs 2 of them | — |
| Telephony | `telephony/tests/` | none defined | probe needs Docker |
| Android | `android/app/src/{test,testAcceptance,androidTest}` | `bash android/tools/bootstrap-gradle.sh --no-daemon :app:testReleaseUnitTest` | Instrumented tests need an emulator |
| Python source tests | `gravity-mvp/src/**/__tests__/*_source_test.py` | no runner in the repository | — |

### 6.2 Authoritative CI

- `.github/workflows/architecture-enforcement.yml` runs on every pull request and
  push to `main`: `node tools/architecture/run-authoritative-ci.mjs` (53 controls,
  sequential, fail-fast), then a Gravity image build.
- Preconditions of the runner: Node exactly 20.20.2; clean worktree including
  untracked files; `YOKO_BLAST_BASE=HEAD^` locally; `DATABASE_URL` with
  `?schema=yoko_migration_authority_replay_*` for the replay controls;
  `npm ci` + `prisma generate` in `gravity-mvp` and `tg-bot`.
- The only behavioural tests it runs are the two `test:security-boundaries`
  scripts. It does not run the Gravity vitest suite.
- `tools/architecture/check-blast-radius.mjs` reports affected contexts and the
  manifest verification commands for a change set; it does not select what the
  runner executes. Any change under `architecture/` or `tools/architecture/`
  affects all 16 contexts.
- Other workflows: `agent-architecture-contract.yml` (agent instruction files),
  `android-acceptance-e2e.yml` (Android epic branches only),
  `coordinated-gravity-max-6e3f094b.yml` (one release branch only).

### 6.3 Routing by change class

| Change class | Targeted verify | Full 53-control suite | Host/runtime check |
|---|---|---|---|
| UI-only | affected vitest files; `check-typescript-baseline.mjs` | Runs on the PR | Yes — nothing automated renders the UI |
| API route | route `*.test.ts`; `enforce-architecture.mjs`; security subset if public/credential-adjacent | PR | Yes |
| Module internal | manifest `verification.module_tests`; module vitest | PR | Depends |
| Public contract | `validate-contract-registry.mjs`, `check-contract-boundaries.mjs`, `test-contracts.mjs`, `validate-context-manifests.mjs` | PR | No |
| New file / owned path | `test-executable-path-ownership.mjs`, `validate-context-manifests.mjs` | PR | No |
| Prisma schema / migration | `validate-production-migration-authority.mjs`, replay control, the migration's `.postgres.test.ts` | PR | Yes — migrations apply at container start |
| Provider adapter | provider boundary checks; module vitest | PR | Yes — live provider |
| Satellite service | its own tests (table above) | PR runs governance only | Yes |
| Docker / compose / nginx | none behavioural | PR | Mandatory |
| CI control edit | `test-authoritative-ci-inventory.mjs` + the control's negative test | PR | No |
| Android | Gradle unit tasks | — | Device / emulator |

Governance side effects to plan for (flags verified in source; exact ordering not
re-derived here):

- **New or moved tracked file**: ownership denominator changes —
  `validate-executable-path-ownership.mjs` (`--preview-reviewed-current-denominator`,
  `--materialize-reviewed-current-denominator`, `--generate-contexts`) and the
  `denominator` pin in `test-executable-path-ownership.mjs`.
- **Edit of a hash-pinned surface** (scripts, compose, Dockerfile, `deploy.sh`):
  rebind `source_sha256` in `LIFECYCLE_SURFACE_CLASSIFICATION_REGISTRY.json`.
- **Import changes across contexts**: `derive-final-dependency-source.mjs --write`.
- **New sensitive env name**: add to the manifest's
  `credential_relationships.environment_names`.
- **New migration**: wrap SQL in `BEGIN; … COMMIT;`; append a row to
  `architecture/migrations/v1/pending-source-migrations.json` (name, path, sha256,
  size, owner context, classification, `migration_test`, `creates`); rebind
  `source_schema.sha256`.

Migration mechanics: `gravity-mvp/Dockerfile` CMD runs
`npx prisma migrate deploy && npm run start`; `scripts/deploy.sh` also runs
`migrate deploy` before `up`. The authority is frozen at 62 rows (44 in
`gravity-mvp/prisma/migrations`, 18 in the archive) plus 6 pending rows marked
`production_application: false`. A fresh database built from
`gravity-mvp/prisma/migrations` alone will lack the archive-created tables.

### 6.4 Verification gaps

| ID | Gap | Evidence |
|---|---|---|
| G-01 | ~273 of 282 Gravity vitest files run in no workflow on main | `run-authoritative-ci.mjs` step list; no `vitest` in workflows |
| G-02 | `*.postgres.test.ts` proofs are skipped in CI; the migration authority checks only that the file exists | env-gated tests; pending-source `migration_test` field |
| G-03 | Scraper, audio-bridge (12 of 14 files), YFS, tg-bot `test:services`, Python source tests: no CI | package scripts, workflows |
| G-04 | Build ignores type and lint errors (`ignoreBuildErrors`, `ignoreDuringBuilds` in `gravity-mvp/next.config.ts`); the TS gate tolerates a baseline of diagnostics; ESLint is in no CI | config files |
| G-05 | Nothing validates nginx templates, compose configuration or image/schema compatibility | no control |
| G-06 | Android acceptance does not run for PRs to main | workflow triggers |
| G-07 | No test of Chat workflow transitions (`ConversationWorkflowService`), ESL call journal (`EslClient.ts`), task triggers (`G/lib/triggers.ts`), retention/integrity engines, MAX `MessageSync` dedupe | no test files found |
| G-08 | 78 `tools/architecture/test-*.mjs` are referenced by no runner | cross-reference of the CI catalog |
| G-09 | Fresh-database bootstrap from the active migrations directory is not proven by CI | archive README; android workflow copies the archive as a workaround |

---

## 7. Important invariants

Each entry: statement — enforcing code — proving test — known exceptions.

### Identity and contacts

- **I-01 One identity per `(channel, externalId)`.** `ContactIdentity`
  `@@unique([channel, externalId])` — `safe-contact-resolution-executor.postgres.test.ts`.
  Exception: no provider-account dimension in the key (`docs/design/provider-account-identity-v1.md`
  defers it); aliases live in `metadata.providerAliasValues`.
- **I-02 Contact-ownership mutations are serialised.** Advisory transaction lock
  + 2 s lock timeout (`CONTACT_OWNERSHIP_BUSY`) in `contact-ownership-coordinator.ts`
  — same postgres test. Exception: `G/app/api/contacts/[id]/route.ts` PATCH and
  ~15 `gravity-mvp/scripts/*` bypass it.
- **I-03 Lock order** Contact → ContactPhone → ContactIdentity → ContactMerge,
  rows ordered by id — `lockContactOwnershipRows`.
- **I-04 Ownership postconditions**: no phone uniquely claimed by two active
  contacts; exactly one active primary equal to `primaryPhoneId`; archived contact
  has a merge edge and no children — `assertContactOwnershipPostconditions` —
  executor and merge-handler tests. Exception: the automatic-merge-blocked path
  skips postconditions by design.
- **I-05 Group chats never create people; untrusted phones never match.** —
  `ContactResolutionService.resolve` — `G/lib/__tests__/contact-resolution-service.test.ts`.
- **I-06 Merge is idempotent and rejects self/archived/contact-to-driver.** —
  `contact-merge-handler.ts` — `contact-merge-handler.test.ts`.
- **I-07 Reachability never downgrades `confirmed`.** — `G/lib/ReachabilityService.ts`
  — `G/lib/ReachabilityService.test.ts`.

### Messaging

- **I-08 One `clientMessageId` = one row and one dispatch; a different intent
  under the same key is rejected.** `MessageService.send` + unique
  `Message.clientMessageId` — `operator-delivery-retry.test.ts`.
  Exception: `send-media` has no such lookup (R-04).
- **I-09 Inbound dedupe on `Message.externalId` (unique).** — receive and
  external-message adapters. Exception: `createChannelMessageV1` leaves dedupe to
  the caller; Telegram and WhatsApp add a same-content time-window dedupe.
- **I-10 Redelivery only when the failure is classified `safe_to_redeliver`
  under taxonomy v2.** — `classifyDeliveryOutcome`, `isSafeToRedeliver`
  (`retrySend`), the retry SQL selector — `delivery-recovery-operations.test.ts`,
  `shared-retry-safety.test.ts`. An adapter code token in the error decides
  first: `<PREFIX>_NOT_DISPATCHED` → `safe_to_redeliver`, `<PREFIX>_REFUSED` →
  `terminal`, `<PREFIX>_SEND_OUTCOME_UNKNOWN` → `unknown` (with several codes the
  least permissive wins). Provider-text patterns apply only without a code, and an
  unclassified error is `unknown`. Only rows with `errorSchemaVersion` ≥ 2 can be
  redelivered; a v1 `retryable` row fails closed.
- **I-10a An `unknown` outcome is never resent** — not by the retry job, not by an
  operator retry. `retrySend` also refuses a row that carries provider evidence
  (`externalId`, MAX `deliveryConfirmed`), and stuck `sent` rows become `unknown`
  on every channel (F-12). — `MessageService.retrySend`, `recoverStuckMessages` —
  `shared-retry-safety.test.ts`, `shared-retry-safety.postgres.test.ts`.
- **I-10b A provider id owned by another row is never reassigned.** A finalize
  that hits the unique `Message.externalId` leaves the id with its owner. A mirror
  of this send (same chat, outbound, same text, no `clientMessageId`) lets the
  send stand; any other owner makes this row `failed` with `PROVIDER_ID_CONFLICT`
  and outcome `unknown`. — `providerIdOwnership` in `G/lib/MessageService.ts` —
  `shared-retry-safety.test.ts`, `shared-retry-safety.postgres.test.ts`.
- **I-11 A retry is admitted once** (compare-and-set on `status='failed'` +
  `updatedAt`; finalisation fenced by lease id) —
  `G/lib/MessageService.provider-account.test.ts`.
- **I-12 No cross-channel send.** A channel override ≠ `Chat.channel` throws
  `CONTACT_CONVERSATION_CHANNEL_MISMATCH` — same test file.
- **I-13 Delivery capability registry fails closed when unregistered.** —
  `channel-delivery-runtime.ts` — `channel-delivery-runtime.test.ts`.
- **I-14 Message and push intent commit atomically; fan-out event ids are
  deterministic.** — inbound adapters, fan-out adapter —
  `internal/mobile-push/mobile-push.postgres.test.ts`.
- **I-15 Outbox claim is compare-and-set; bounded attempts; stale-claim
  recovery; dead letter.** — `prisma-outbox-store.ts` — `prisma-outbox-store.test.ts`.
- **I-45 Contact → conversation read is exact-link, provider-neutral,
  private-only, read-only and deterministic.** A conversation is a Contact's only
  when `Chat.contactId` is the requested id or its canonical survivor — never by
  phone, ChannelIdentity, provider identity or heuristic; group chats never count;
  workflow status never hides one; one total order (`lastActivityAt` DESC nulls
  last, `createdAt` DESC, `conversationId` ASC) picks every primary and latest
  conversation; nothing is written, created or sent; an unknown stored channel or a
  broken merge lineage fails the query; a `truncated` answer never proves absence.
  — `contact-conversations-query-handler.ts`, the legacy Prisma adapter —
  `contact-conversations-query.test.ts`. Known limit (v1): conversations still
  linked to other merged-away aliases of the person (not the requested id) are not
  looked for; merges move conversations to the survivor, so this matters only
  after a failed merge.

### Channels

- **I-16 Telegram message identity is namespaced by account, peer and message
  id; a changed account on a cached client fails closed.** — `G/app/tg-actions.ts`
  — `G/app/tg-actions.identity.test.ts`.
- **I-17 One driver per Telegram id and vice versa.** — `DriverTelegram` unique
  columns + in-transaction authority re-read — manual-link adapter tests.
- **I-41 For Telegram, `Chat.chatType` is the single private/group source.**
  `metadata.chatKind` is not consulted for Telegram (MAX still requires both). —
  `manual-driver-telegram-link-authority.ts`,
  `G/modules/platform-shell/application/outbound-conversation-identity.ts` —
  authority tests, `check-telegram-driver-link-boundary.mjs`.
- **I-42 The Driver ↔ Telegram person proof carries no transport; the Driver Bot
  transport is configuration.** A `Chat`-stored connection or provider account is
  never authority, and an unconfigured transport fails closed. —
  `prepareDriverTelegramConversationAuthorityV1`,
  `canonicalTelegramBotConnectionIdV1` —
  `manual-driver-telegram-link-authority.test.ts`, `bot-transport-config.test.ts`,
  `G/app/api/webhooks/bot/route.test.ts`.
- **I-43 Telegram bot inbound is persist-first.** An authenticated, de-duplicated
  event of an admitted conversation is written before person enrichment; a
  blocked enrichment is reported, never answered as retryable. —
  `G/app/api/webhook/telegram/route.ts` — its route test,
  `check-messaging-conversation-contact-link-boundary.mjs` (placement pin).
- **I-44 tg-bot awaits the CRM forward; a failed update stays retryable and a
  completed one is not re-executed.** An `update_id` is recorded only after its
  handler chain succeeds. — `tg-bot/src/bot.js`,
  `tg-bot/src/services/crmIntegration.js`, `tg-bot/src/services/botRuntime.js` —
  `tg-bot/src/security/crmForwardOutcome.test.js`,
  `tg-bot/src/security/botRuntimeUpdateLifecycle.test.js`.
- **I-18 A WhatsApp private chat owned by another connection is never written.**
  — `assertPrivateWhatsAppConversationConnectionV1` —
  `WhatsAppService.connection-binding.test.ts`.
- **I-19 MAX webhook is authenticated (timing-safe) and requires the provider
  account both ways.** — `scraper-webhook-auth.ts`, `requireLiveMaxProviderAccount`
  in the scraper, `messaging-transport.ts` — `G/app/api/webhooks/max/route.test.ts`,
  `gravity-mvp/test/max-delivery-http-boundary.test.ts`.
- **I-20 MAX `delivered` requires a provider-shaped id with agreeing
  confirmation fields, or a UI-send proof bound to `clientMessageId`.** —
  `validateMaxTextDeliveryResultV1` — `gravity-mvp/test/max-delivery-validation.test.ts`.
  Note: the UI proof means the compose box cleared, not a provider receipt.

### Calling

- **I-21 One `Call` row per FreeSWITCH call.** `Call.fsUuid` unique; create only
  on the trunk leg — no unit test of `EslClient.ts` found.
- **I-22 AI-call lifecycle is a legal-transition state machine; terminal states
  are not overwritten.** — `ai-call-lifecycle.ts`, row lock in the adapter —
  `ai-call-lifecycle.test.ts`.
- **I-23 AI-call finalisation is idempotent and creates exactly one follow-up
  task.** — fingerprint journal, lease, `createIdempotentTaskV1` —
  `ai-call-finalization.test.ts`.
- **I-24 Controlled real call: one attempt per approved request id, single
  allowlisted destination, no retry on unknown outcome.** —
  `controlled-real-ai-call*.ts` — matching tests.
- **I-25 Bridge callbacks require a strong shared secret (constant-time, fail
  closed).** — `bridge-machine-auth.ts` — `bridge-machine-auth.test.ts`.
- **I-26 Campaign uniqueness and fencing** (launch id, member/attempt number,
  admission lease, claim fences) — campaign adapter — `ai-call-campaign.postgres.test.ts`.
- **I-27 Call-alert kinds: incoming only on creation, missed once, never for
  outbound or simulation.** — `callAlertKindForTransitionV1` —
  `call-alert-transition.test.ts`.

### Cash compensation

- **I-28 Monetary constraints are in the database**: budget
  `reserved + settled <= limit`; application amount bounds; attempt number 1..2;
  `PAID` ⇔ `paidAt`; one claim per `(provider, externalParkId, externalOrderId)`;
  one pending application per person; one compensated cash order per person per
  ORDER business day (`Asia/Yekaterinburg` day of `CompensationOrderClaim.orderEndedAt`,
  held as `CompensationPayoutAuthorization.intendedBusinessDay` by the partial unique
  index `CompensationPayoutAuthorization_person_day_key` over `active / unknown_outcome /
  finalized`; `cancelled` and reconciliation `not_paid` release it; submission, rejection,
  idempotent replay and a failed transaction consume nothing; one person shares the limit
  across every profile and park; `CompensationSettlement.businessDay` is the settlement
  day from the database clock, not the slot); one settlement per
  application/authorization/claim — CHECKs and (partial) unique indexes in
  `20260910220000_add_compensation_monetary_core/migration.sql`;
  `compensationPayoutSlotDayV1` / `compensationSettlementBusinessDayV1` in
  `COMP/compensation-policy.ts` — `COMP/*.postgres.test.ts`.
- **I-29 Fixed lock order; Contact tables are never locked by compensation.** —
  `COMPENSATION_LOCK_ORDER_V1`, `COMPENSATION_FORBIDDEN_LOCK_ENTITIES_V1` in
  `COMP/compensation-policy.ts`.
- **I-30 Budget periods can be created and raised, never lowered or reopened.**
  — `compensation-budget-period-service.ts` — `compensation-budget-period.postgres.test.ts`.
- **I-31 The acting manager principal comes only from the session.** —
  `compensation-manager-principal.ts` — its test. Exception: the session itself is
  the unsigned browser cookie (F-25); the real gate on `/compensation` is nginx
  Basic Auth (`check-compensation-edge-perimeter-boundary.mjs`).

### Fleet, work, platform

- **I-32 Single Yandex sync holder.** Lease on `SyncStatus` with stale takeover
  — `G/lib/yandexSync.ts` — `yandex-sync-lease.test.ts`.
- **I-33 Driver identity** `(externalParkId, externalDriverProfileId)` unique —
  schema + `upsertObservation` — reconciler adapter tests.
- **I-34 Idempotent cross-context task creation.** Deterministic primary key +
  fingerprint — `legacy-prisma-idempotent-task-adapter.ts` — its tests.
- **I-35 Mobile push device/operator come from the session, never the body;
  `deviceId` and `fcmToken` unique.** — `mobile-push-registration-handler.ts` —
  `mobile-push-registration.postgres.test.ts`.

### Governance (enforced by controls)

- **I-36 No foreign writes, private cross-context imports, undeclared
  dependencies or undeclared sensitive env names.** — `enforce-architecture.mjs` —
  `test-architecture-enforcement.mjs`.
- **I-37 Contract registry equals manifest surfaces exactly.** —
  `validate-contract-registry.mjs` — `test-contract-registry.mjs`.
- **I-38 Every tracked executable surface is owned or a governed exclusion.** —
  `validate-executable-path-ownership.mjs` — `test-executable-path-ownership.mjs`.
- **I-39 Migration history replays to zero datamodel diff against
  `schema.prisma`.** — the `production-migration-*` controls —
  `test-production-migration-authority.mjs`.
- **I-40 The CI control catalog, workflow step list and Node version are
  pinned.** — `test-authoritative-ci-inventory.mjs`.

---

## 8. Runtime and deploy map

`deploy/docker-compose.production.yml` (project `crm`, network `crm_internal`):

| Service | Build / image | Exposure | Notes |
|---|---|---|---|
| `postgres` | `postgres:16-alpine` | internal | Shared by Gravity and tg-bot |
| `redis` | `redis:7-alpine` | internal | BullMQ (Gravity calls, scraper) |
| `minio`, `minio-init` | `minio/minio` | 127.0.0.1:9000/9001 | Recordings |
| `freeswitch` | `telephony/` | host network | ESL 8021 |
| `audio-bridge` | `tools/audio-bridge-day1/` | 127.0.0.1:3030 | AI calls |
| `nginx`, `certs-init` | `nginx:1.27-alpine` | 80, 443 | Templates in `deploy/nginx/templates/` rendered into `conf.d` |
| `gravity-mvp` | `gravity-mvp/` | internal 3002 | Runs migrations at start |
| `tg-bot` | `tg-bot/` | internal 3001 | — |
| `tg-bot-frontend` | `tg-bot/tg-bot-frontend/` | internal 3004 | — |
| `yandex-fleet-scraper-api`, `-worker` | `yandex-fleet-scraper/` | internal 3003 | SQLite volume, `prisma db push` |
| `max-web-scraper` | `max-web-scraper/` | internal | Playwright profile volume |

There is no `avito-worker` service in this file. All app services read
`../.env.production`.

nginx routing (`deploy/nginx/templates/crm.conf.template`,
`bot-admin.conf.template`): CRM domains → `gravity-mvp:3002`; `/api/debug-db` →
404; `/compensation` → Basic Auth; `/wss-sip` → FreeSWITCH WSS on the host; bot
admin domain → `tg-bot` (`/api/telegram/`) and `tg-bot-frontend`.

Documented deploy: `scripts/deploy.sh` (fetch, build, migrate, `up -d`, health
wait). Backups: `scripts/backup-{pg,files,env}.sh`, restore scripts,
`scripts/health-monitor.sh`. Secrets inventory: `docs/SECRETS.md`. The repository
documents only this model; anything else about how production is actually released
is outside this map.

---

# OBSERVED DEBT / CLEANUP CANDIDATES

Nothing in this part describes intended architecture, and nothing here has been
changed. Each item is a documented observation with evidence and a confidence
level. "Pinned" means the path is hash-registered by governance
(`LIFECYCLE_SURFACE_CLASSIFICATION_REGISTRY.json` and related files), so removal
needs a coordinated rebind even when the runtime risk is nil.

## 9. Observed defects and risks (behaviour, not cleanup)

Documented, not fixed. Confidence refers to "this is what the code on main does".

| ID | Observation | Evidence | Confidence |
|---|---|---|---|
| R-01 | Browser lane has no authentication in application code: identity is an unsigned, client-settable cookie picked from a list | `G/lib/users/user-service.ts` (`login`), `G/proxy.ts` | HIGH |
| R-02 | Eight of nine `/api/cron/*` routes contain no auth check; `sync-scraper` and `AVITO_WEBHOOK_TOKEN` accept everything when the secret is unset | route files; `verifyAuth` in `G/app/api/webhooks/avito/route.ts` | HIGH |
| R-03 | AI auto-reply sends through the channel without persisting a `Message` | no message write site in `G/modules/messaging/internal/ai-reply-pipeline/` | HIGH |
| R-04 | `send-media` dispatches before persisting and has no `clientMessageId` lookup; a repeated request re-sends | `G/app/api/messages/send-media/route.ts` | HIGH |
| R-05 | `recoverStuckMessages` replaces `metadata` wholesale for non-MAX rows (the MAX branch merges) | `G/lib/MessageService.ts` ~L415–455 | HIGH |
| R-06 | Bot-lane inbound and lead intake never call `publishPersistedMessageV1` → no SSE push and no AI pipeline for those messages | `G/app/api/webhook/telegram/route.ts`, `G/lib/leads/intake.ts` | HIGH |
| R-07 | `MessageEventLog` has no re-drive; a crash leaves events and `aiStatus` stuck | writers are only insert + claim/complete/fail | HIGH |
| R-08 | Android discards call alerts: `PushPayload` knows only `chat_message` while the server sends `call_incoming` / `call_missed` | `android/app/src/main/java/ru/yokoone/crm/shell/push/PushPayload.kt` | HIGH |
| R-09 | Scraper result webhook target has no path in the base compose file (`CRM_WEBHOOK_URL: http://gravity-mvp:3002`) while the worker posts to it verbatim and the receiver is `/api/monitoring/fleet-check/callback` | compose L485, L517; `yandex-fleet-scraper/src/worker.ts` `fireWebhook` | HIGH for base compose; production overlay unknown |
| R-10 | Fleet-check quota comparison uses fields the scraper `/admin/stats` does not return | `G/app/api/monitoring/drivers/[id]/fleet-check/route.ts` L71; `/admin/stats` in `yandex-fleet-scraper/src/api.ts` returns queue counts only | HIGH |
| R-11 | tg-bot falls back to secret `'secret'` when `BOT_CRM_SECRET` is unset | `tg-bot/src/services/crmAction.js` L29 | HIGH |
| R-12 | `getTelegramClient` triggers `catchUpMissedMessages` on every cached-client fetch | `G/app/tg-actions.ts` L1316, L1323 | HIGH |
| R-14 | `/api/ai-calls/dev-simulate` is enabled unless an env flag is exactly `'false'` | `G/app/api/ai-calls/dev-simulate/route.ts` L41 | HIGH |
| R-15 | Retention has only a 24 h interval with no startup run; a process restarted more often than daily never runs it | `G/instrumentation.ts` | MEDIUM |
| R-16 | Operational log tables grow without cleanup (`cron_health_log` gets a row per watchdog tick) | `G/lib/cron-health.ts`; no cleanup caller | MEDIUM |
| R-17 | Runtime-rewritten files inside the image: `G/data/users.json`, `G/data/dictionaries.json` | `user-service.ts`, `task-dictionary-store.ts` | HIGH for the write; persistence across deploys unknown |
| R-18 | Insecure compose defaults (`ESL_PASSWORD:-ClueCon`, `MANAGER_10x_PASSWORD:-changeme10x`); two env names for the ESL secret (`ESL_PASSWORD`, `FS_ESL_PASSWORD`) | compose; `EslClient.ts`, controlled-call adapter | HIGH |
| R-19 | `getTasks` writes on read (flips overdue, recalculates attempts) | `G/app/tasks/actions.ts` ~L451–470 | MEDIUM |
| R-20 | Many API routes perform no in-route auth (messages, chats assign, tasks reassign, max-scraper restart, import-jobs, whatsapp delete, fleet-check callback) | route files; `G/proxy.ts` passes the browser lane | MEDIUM as a count; follows from R-01 |

## 10. Cleanup candidates

Fields: **Path** · **Evidence** · **Why** · **Confidence** · **Risk if removed** ·
**Owner** · **Follow-up**.

### HIGH confidence

- **C-01** `gravity-mvp/fix_*.js`, `append_*.js` and similar root patchers ·
  not referenced by `package.json` or the Dockerfile; registry marks them
  DEAD_HISTORICAL · one-shot source patchers · HIGH · runtime none; pinned ·
  platform / governance · remove together with a registry rebind.
- **C-02** `gravity-mvp/*.txt`, root `*.json` dumps (`db_log.txt`, `dump.json`, …)
  · no reader; unpinned; several contain phone numbers · captured stdout · HIGH ·
  none technical; PII remains in history · platform · PII review, untrack, ignore
  patterns.
- **C-03** `gravity-mvp/baseline.prisma`, `current_schema.prisma.bak`,
  `current_schema.prisma.utf8`, `gravity-mvp/dev.db`, `gravity-mvp/prisma/dev.db`
  · Gravity datasource is PostgreSQL; schema copies are far behind · stale copies
  · HIGH · confirm no script reads `baseline.prisma` · platform · check readers,
  then untrack.
- **C-04** `yandex-fleet-scraper/.artifacts/` (107 PNG) · directory is already in
  that service's `.gitignore`; unpinned · committed before the ignore rule · HIGH
  · none; likely PII · fleet · untrack.
- **C-05** `max-web-scraper/*.png`, `debug_*.txt`, `max_dom_dump.txt`,
  `maxBrowser.js.bak`, `parse*.js`, `test*.js` · ignore rules exist; the Dockerfile
  copies the directory, so much of it ships in the image · debug captures · HIGH ·
  js files pinned · max · untrack and widen `.dockerignore`.
- **C-06** Deprecated re-export shims: `G/components/ui/*`, `G/components/sip/*`,
  `G/lib/utils.ts`, `G/lib/phoneUtils.ts`, `G/lib/contactDisplay.ts`,
  `G/lib/sip/SipContext.tsx`, `G/store/*`, `G/hooks/use-task*.ts` · 1–13-line
  re-exports with no production importer · superseded by `G/infrastructure/ui` and
  module public surfaces · HIGH · pinned; a compatibility test asserts them ·
  platform_shell · remove shims and their compatibility tests in one rebind.
- **C-07** `G/app/api/debug-db/**` (8 routes) · denied by both `G/proxy.ts` and
  the nginx template · unreachable · HIGH · some require integration-admin and are
  referenced by tests · identity / owners · decide remove vs keep-for-dev.
- **C-08** `G/app/api/test-car/route.ts`, `G/app/api/test-driver/route.ts` · no
  caller; no auth in file; use stored Yandex credentials · debug endpoints · HIGH ·
  none found · fleet · guard or remove first (security-relevant).
- **C-09** Tombstones and their stale callers: `G/app/api/webhook/max/route.ts`
  (410), `…/sync-names`, `…/unlinked-chats`, `G/app/api/chats/find-max/route.ts`
  (409), `G/app/api/contacts/[id]/merge/route.ts` (409);
  `max-web-scraper/sync/NameSync.js` still calls the retired endpoints and is
  still started from `index.js` · retired behaviour kept alive on one side · HIGH ·
  tombstone tests exist · max / contacts · retire NameSync, then the tombstones.
- **C-10** Stale docs: `CLAUDE.md` ("OS: Windows", `prisma migrate dev` as safe),
  `.cursorrules`, `PROJECT_STRUCTURE.md` (5 modules), `README.md`,
  `docs/operations/deployment.md` (systemd/NSSM/PM2 paths that do not exist),
  `.claude/knowledge/max_chat_merging.md`, `.claude/skills/*` referencing missing
  scripts, `architecture/enforcement/v1/README.md` (exception count) · contradicts
  the repository · HIGH · `CLAUDE.md` is covered by the agent-contract workflow ·
  platform · correct in a docs-only change.
- **C-11** `gravity-mvp/package.json`: `whatsapp-web.js` pinned to
  `github:…#main` · moving branch reference · HIGH · behaviour change on reinstall
  · whatsapp · pin to a commit.
- **C-12** Stale manifest content: owned paths that do not exist
  (`gravity-mvp/src/lib/providers/max-personal`,
  `gravity-mvp/src/app/api/bot-users/pending-link-requests.ts`); env names read
  nowhere (`TELEGRAM_BOT_URL`, `BRIDGE_ALLOWED_IPS`); outdated
  `current_writer_modules`; declared commands/events with no code symbol · manifest
  drift · HIGH · manifests are generated and hash-pinned · governance · regenerate
  through `context-decisions.json`.
- **C-13** Dead MAX send code: `sendMaxMessage` / `sendMaxPersonalMessage` in
  `G/app/max-actions.ts` (no callers); `sendMaxDriverMessageV1` always throws but
  is still called from `G/app/drivers/DriversClient.tsx` · superseded by the
  delivery capability · HIGH · UI button behaviour · max / fleet · remove the call
  path or implement it.
- **C-14** `G/lib/execution-lock.ts` lock functions, `G/lib/perf-monitor.ts`
  writers, `logConfigChange` · no callers found · unused infrastructure · HIGH ·
  tables exist; read by system-health · ops · decide adopt vs remove.
- **C-15** `architecture/**/SHA256SUMS` · most fail `sha256sum -c`; no CI control
  reads them (except migration provenance) · look authoritative but are not · HIGH
  · none functional · governance · regenerate or delete with a note.
- **C-16** `G/components/messenger/Messenger.tsx` (909 lines) · no importer; it is
  the only caller of `/api/messages/profiles`, `/api/messages/drivers/**`,
  `/api/messages/start-chat` (a 409 stub) · superseded by `G/app/messages` · HIGH
  for the component, MEDIUM for the routes · pinned · messaging · confirm with a
  build, remove component then routes.
- **C-17** `tg-bot/package.json` `start:direct` points at a missing `bot.js`;
  `tg-bot/*.xlsx`; ~30 root one-off scripts not copied into the image · leftovers ·
  HIGH · js files pinned · telegram · fix script, untrack xlsx.
- **C-18** Misleading names on production paths: `tools/audio-bridge-day1`,
  `telephony/conf/dialplan/default/99_audio_fork_test.xml` (the production AI
  extension 9999) · naming obscures ownership · HIGH · renames touch compose,
  readiness checks and pins · calling · rename only as a dedicated change.
- **C-19** Duplicated helpers: phone normalisation (canonical
  `G/modules/contacts/public/v1/phone-identity.ts` vs. local versions in
  `G/app/api/monitoring/sync/route.ts`, `G/app/api/webhooks/bot/route.ts`,
  `G/lib/DriverMatchService.ts`, fleet `park-phone-search.ts`,
  `max-web-scraper/index.js`, `avito-worker/src/*`); day-boundary maths (no shared
  helper; server-local `setHours(0,0,0,0)` in many files, `Asia/Yekaterinburg` in
  compensation) · divergent business rules · HIGH · behaviour differences are
  semantic · contacts / platform · inventory semantics before consolidating.
- **C-20** `G/app/dashboard/components/*` (no importer; `G/app/dashboard` has no
  page) and `G/config/navigation.ts` (superseded by `navigation-domains.ts`) ·
  orphans · HIGH · pinned · analytics / platform · remove after build check.

### MEDIUM confidence

- **C-21** ~45 root diagnostics in `gravity-mvp/` (`check*.js`, `debug*.js`,
  `test_*.js`, `run_45d_sync.js`, `wa-cleanup.ts`) · no package script; many pinned
  as OPERATIONAL_SCRIPT · ad-hoc probes · MEDIUM · pinned · per domain · owner
  confirms "never run again" before reclassifying.
- **C-22** `gravity-mvp/scripts/` (216) and the paired
  `G/modules/**/public/v1/legacy-prisma-*-maintenance-adapter.js` (incl.
  person-specific ones) · most are incident- or person-specific; not in the image ·
  a governed write path for one-off scripts now lives in module public APIs ·
  MEDIUM · pinned and asserted by boundary controls · per domain · keep/retire
  table per domain; retire script and adapter together. Clearly operational and to
  keep: `check-public-boundaries.mjs`, `compensation-*.ts`, `ensure_*.js`,
  `cleanup_stale_ai_sessions.js`, `baseline-vps.sh`.
- **C-23** Orphan-looking real code: `G/lib/retry.ts`,
  `G/app/messages/hooks/useScrollController.ts` (only its test imports it),
  `G/app/drivers/archive/ArchiveClient.tsx`, `G/app/drivers/cards/CardsClient.tsx`,
  `G/app/tg-bot-broadcast.ts`, `G/app/actions.ts`,
  `G/app/messages/components/MiniSidebar.tsx` · no importer found by an import-graph
  scan · MEDIUM (server-action files and computed imports are not fully resolved) ·
  pinned · per domain · confirm against a build manifest.
- **C-24** `max-web-scraper/maxBrowser.js` (999 lines) · self-described legacy, not
  required by `index.js` · MEDIUM · may be read by source tests / pinned · max.
- **C-25** API routes with no in-repo caller: `/api/cron/*`,
  `/api/admin/contact-health`, `/api/monitoring/{guardrails,stability,sync}`,
  `/api/transport/health`, `/api/whatsapp/delete`, `/api/tasks/resolve-escalation`,
  `/api/max-scraper/import-progress`, `/api/messages/send-image`,
  `/api/tg-media/[fileId]` · no fetch string or caller · LOW–MEDIUM — an external
  scheduler or client cannot be ruled out from the repository · ops · check
  production access logs before deciding.
- **C-26** Pages outside navigation or stubs: `G/app/map/page.tsx`,
  `G/app/inbox/page.tsx`, `G/app/monitoring/system-health/`,
  `G/app/settings/{scoring,triggers,avito-access}/`; `PageShell` stubs under
  `G/app/{promotions,resources,communications,control,analytics}`; `G/app/page.tsx`
  renders `G/lib/mock/dashboardData.ts` · MEDIUM · product decision · platform.
- **C-27** Contacts leftovers: `resolveWithAutomaticMergeV1`
  (`G/modules/platform-shell/public/v1/contact-resolution.ts`) has no production
  caller; `legacy-prisma-mark-temporary-contact-phone-adapter.ts`,
  `legacy-prisma-contact-phone-adapter.ts`, `legacy-prisma-fleet-contact-adapter.ts`
  are referenced only by checkers; unused operations
  (`setContactDisplayNameV1`, `expireTemporaryContactPhonesV1`) · superseded by the
  ownership-persistence ports · MEDIUM · boundary controls reference them ·
  contacts.
- **C-28** Legacy/compatibility schema: the 27 `Max*` models,
  `ContactDriverProfileAudit` · tables created by archived migrations recorded as
  applied; no code on main; source branch not merged · **CLEANUP CANDIDATE — NEEDS
  FOLLOW-UP PROOF** · MEDIUM that they are unused by main; removal is **not safe**
  as-is: the replay control requires schema parity, and dropping tables needs a
  governed migration plus proof of the production data state · max / contacts /
  governance · first decide whether the unmerged lineage will land.
- **C-29** Models with no writer or no reader found on main: `MaxPersonalSession`,
  `DriverMax`, `WhatsAppChatRoster`, `DailyParkStats` (read by the dashboard, no
  writer), `Broadcast` / `BroadcastStat`, `ManagerTask` (no creator), scraper
  `AuditLog` · scan + reading · MEDIUM (raw SQL and out-of-band writers not
  excluded) · schema parity and migrations · owning contexts · per-model proof.
- **C-30** `tools/fs-config/*.xml` · differs from `telephony/conf`; a telephony
  test still asserts on it · divergent manual copy · MEDIUM · test dependency ·
  calling.
- **C-31** One-off workflow `.github/workflows/coordinated-gravity-max-6e3f094b.yml`
  · single branch, fixed commit and artifact ids · MEDIUM · a CI test asserts its
  name; pinned · governance.
- **C-32** Tests with no runner: 78 `tools/architecture/test-*.mjs`, Python
  `*_source_test.py`, 12 of 14 bridge tests, scraper tests · no script/workflow ·
  MEDIUM · none · platform · document or wire a runner per family.
- **C-33** `architecture/recovery/control-plane/v2/owner-bootstrap/**` (~740 MB of
  `.deb`/`.tar`, duplicated across `dist/`, `bundle/payload/`, `inputs/`) and
  ~100 scan/triage dumps under `architecture/recovery/whole-project-dod/v2/` ·
  frozen evidence in git · MEDIUM (duplication certain) · VERY HIGH: tests and
  controls name these packages · governance · decide on external artifact storage.
- **C-34** `CommunicationTrigger` · CRUD only; no evaluator found · MEDIUM ·
  settings page depends on it · messaging / configuration.
- **C-35** Duplicated schema definitions: the 8 bot models in both
  `tg-bot/prisma/schema.prisma` and Gravity's schema; `avito_*` tables in Prisma
  and in `avito-worker/_shared/db` (Drizzle) · manual sync against one database ·
  HIGH that duplication exists, MEDIUM on what to do · drift · telegram / avito.
- **C-36** `G/lib/ai-call/devSimulator.ts` mirrors the bridge's tool list and turn
  loop (header says the duplication is deliberate) · drift risk · MEDIUM · used by
  `/api/ai-calls/dev-simulate` · calling.
- **C-37** `yandex-fleet-scraper/update_locator*.cjs`, `fix-accounts.ts`,
  tracked `yandex-fleet-scraper/dev.db`, `prisma/dev.db` · not referenced by
  package scripts or the Dockerfile · MEDIUM · db files may be a dev seed · fleet.
- **C-38** Unreachable `/debug/*` handlers in `max-web-scraper/index.js` kept
  behind a 404 middleware because a source test requires them; unauthenticated
  diagnostic routes (`/probe-ui-search`, `/scan-max-bundle`, `/contacts`, …) ·
  MEDIUM · test dependency · max.

### LOW confidence

- **C-39** `G/scripts/force-clear-locks.ts` · no importer; pinned · LOW · ops.
- **C-40** MAX contact-resolution shadow
  (`G/lib/contacts/max-contact-resolution-shadow.ts`, flag
  `CONTACT_RESOLUTION_SHADOW_MAX`) · log-only; appears to compare against the same
  executor it shadows · LOW · a boundary control covers it · contacts.
- **C-41** Root `check-last-call.sql`, `last-call-uuid.sql`, `start-all.bat`,
  `gravity-mvp/*.sql` · ad-hoc; `start-all.bat` is cited by docs · LOW–MEDIUM ·
  pinned · platform.

Totals: 20 HIGH, 18 MEDIUM, 3 LOW.

## 11. Complexity hotspots

Not refactor requests. Each names the concrete way a future change goes wrong.

| ID | Location (lines) | Comprehension risk |
|---|---|---|
| X-01 | `max-web-scraper/index.js` (6960) | One file, one shared Playwright page, ~20 mutable top-level flags acting as mutexes; send, import, sync and probe paths interleave. Correctness depends on flag-check order |
| X-02 | `max-web-scraper/transport/TransportInterceptor.js` (2372) | Hand-written decoder of the provider WebSocket protocol; id coercion accepts several shapes; file side effects |
| X-03 | `G/app/tg-actions.ts` (2211) | A `'use server'` file that is the whole MTProto runtime: process-lifetime Maps, timers, and every export is also a client-invocable action. State is lost on restart |
| X-04 | `G/lib/whatsapp/WhatsAppService.ts` (2995) | The ingest pipeline exists three times (live, `syncHistory`, `importWhatsAppHistory`); a rule changed in one path silently diverges |
| X-05 | `G/lib/MessageService.ts` (1365) | The per-channel `switch` is repeated in `send`, `retrySend`, `ChannelAdapterRegistry` and the media/reaction/delete routes; MAX chat-id drift can move messages and delete a Chat inside `send` |
| X-06 | `G/lib/ContactService.ts` (1103) + executor + coordinator | Invariants are split across planner, executor and postconditions; much state lives in untyped `Contact.customFields` |
| X-07 | `G/app/api/webhooks/bot/route.ts` (1268) | One POST multiplexes ≥16 actions across identity, fleet, orders and compensation |
| X-08 | Driver sync writers | Three independent writers of `Driver` (reconciler adapter, `G/app/drivers/actions.ts`, `G/app/api/monitoring/sync/route.ts`) with different connection-selection and contact-link rules |
| X-09 | `G/instrumentation.ts` (518) | The hidden scheduler and boot sequencer; `/api/cron/*` looks like the scheduler but is not |
| X-10 | `G/app/settings/ai/AiControlCenterClient.tsx` (6525) and `actions.ts` (2488) | UI layer owns AI-knowledge data access (raw SQL) and provider calls; no extraction seams |
| X-11 | `G/modules/calling/internal/ai-calls/ai-call-campaign-prisma-adapter.ts` (1484) | Campaign state machine encoded in raw SQL strings |
| X-12 | `COMP/compensation-prisma-adapter.ts` (1203), `cash-order-ingestion-runtime.ts` (1300) | Money invariants live partly in SQL CHECKs, partly in lock order, partly in one large runtime |
| X-13 | `G/lib/freeswitch/EslClient.ts` (779) | Connection, journal, contact resolution, alerts, timeline projection and originate in one listener; three separate ESL clients exist (this, `esl-originate.ts`, the bridge) |
| X-14 | `G/modules/calling/public/v1/sip-client-context.tsx` (1014) | JsSIP singleton with module-level guards inside a React context; provider tree order matters |
| X-15 | Minified single-line sources (`legacy-prisma-{external-message,channel-message,channel-maintenance}-adapter.ts`, `driver-telegram-handler.ts`, `contact-phone-handler.ts`) | Unreviewable diffs; one of them issues a table-wide MAX chat delete |
| X-16 | Governance cascade | A one-line change can require several ordered registry rebinds; failures surface late because the 53-control runner is fail-fast |
| X-17 | `G/app/tasks/actions.ts` (1196) | An `app/` server-action file used as a shared service (high fan-in), with writes on read |

---

## 12. Quick index for Claude

`I need to change X → read Y` (minimum useful set).

- **Contact** → `G/lib/ContactService.ts`, `G/lib/contacts/SafeContactResolutionExecutor.ts`,
  `G/modules/contacts/internal/contact-ownership-coordinator.ts`,
  `G/modules/contacts/public/v1/index.ts`
- **Contact merge** → `G/modules/contacts/public/v1/contact-merge-handler.ts`,
  `G/infrastructure/contact-merge-composition.ts`
- **Messaging (send/retry)** → `G/lib/MessageService.ts`,
  `G/modules/messaging/public/v1/channel-delivery-runtime.ts`,
  `G/app/api/messages/route.ts`
- **Messaging (inbound persist)** → `G/modules/messaging/application/messaging-operations.ts`,
  `G/lib/messageEvents.ts`
- **Communication / chat UI** → `G/app/messages/` (`hooks/useMessages.ts`,
  `components/ChatList.tsx`, `components/MessageFeed.tsx`,
  `components/ContactProfileDrawer.tsx`)
- **Send to contact** → `G/modules/platform-shell/internal/contact-conversation-orchestrator.ts`,
  `G/modules/platform-shell/public/v1/outbound-conversation-identity.ts`
- **Telegram (operator accounts)** → `G/app/tg-actions.ts`,
  `G/modules/telegram-channel/public/v1/messaging-delivery-capability.ts`
- **Telegram (bot)** → `G/app/api/webhook/telegram/route.ts`,
  `G/app/api/webhooks/bot/route.ts`, `tg-bot/src/bot.js`,
  `tg-bot/src/services/crmIntegration.js`
- **MAX** → `G/app/api/webhooks/max/route.ts`,
  `G/modules/max-channel/public/v1/messaging-delivery-capability.ts`,
  `max-web-scraper/index.js`, `max-web-scraper/transport/TransportInterceptor.js`
- **WhatsApp** → `G/lib/whatsapp/WhatsAppService.ts`,
  `G/modules/whatsapp-channel/public/v1/`
- **Calling (human)** → `G/lib/freeswitch/EslClient.ts`,
  `G/modules/calling/public/v1/sip-client-context.tsx`, `telephony/conf/dialplan/`
- **Calling (AI)** → `G/modules/calling/application/ai-call-finalization.ts`,
  `G/modules/calling/application/ai-call-lifecycle.ts`,
  `tools/audio-bridge-day1/call-session.js`, `G/app/api/ai-calls/`
- **Call alerts** → `G/modules/calling/internal/call-alerts/`,
  `G/modules/calling/application/call-alert-operations.ts`
- **Android** → `android/app/src/main/java/ru/yokoone/crm/shell/`,
  `G/app/api/mobile/push-registration/route.ts`,
  `G/modules/identity-access/internal/mobile-delivery/`, `docs/mobile/`
- **Cash** → `G/modules/fleet-operations/internal/compensation/`
  (`compensation-prisma-adapter.ts`, `compensation-policy.ts`),
  `G/app/compensation/`, `tg-bot/src/handlers/compensation.js`,
  `gravity-mvp/prisma/migrations/20260910220000_add_compensation_monetary_core/`
- **Auth** → `G/lib/users/user-service.ts`, `G/proxy.ts`,
  `G/modules/identity-access/public/v1/`
- **Drivers / Yandex** → `G/lib/yandexSync.ts`,
  `G/modules/fleet-operations/internal/legacy-prisma-yandex-fleet-reconciler-adapter.ts`,
  `G/app/drivers/actions.ts`
- **Tasks** → `G/app/tasks/actions.ts`, `G/lib/tasks/scenario-config.ts`,
  `G/modules/work-management/public/v1/index.ts`
- **Background jobs / boot** → `G/instrumentation.ts`
- **Outbox** → `G/infrastructure/outbox/`,
  `G/modules/platform-shell/public/v1/outbox-runtime.ts`,
  `architecture/events/v1/outbox-manifest.json`
- **Prisma / migrations** → `gravity-mvp/prisma/schema.prisma`,
  `architecture/migrations/v1/pending-source-migrations.json`,
  `architecture/migrations/v1/production-migration-authority.json`,
  `architecture/migrations/v1/archive/README.md`
- **Docker / runtime** → `deploy/docker-compose.production.yml`,
  `deploy/nginx/templates/`, `gravity-mvp/Dockerfile`, `scripts/deploy.sh`,
  `docs/operations/production-release-topology.md`
- **Architecture controls** → `AGENTS.md`,
  `tools/architecture/run-authoritative-ci.mjs`,
  `tools/architecture/enforce-architecture.mjs`,
  `architecture/enforcement/v1/policy.json`,
  `architecture/contexts/v1/manifests/`, `architecture/contracts/v1/registry.json`

---

## 13. Areas not reconstructed confidently

- Anything about the production host: applied migrations, env values, compose
  overlays, external schedulers, edge protection beyond the tracked nginx
  templates.
- Internals read only in outline: `contact-phone-evidence.ts`, the platform-shell
  outbound-identity preparer, cash-order ingestion window/lease logic, the
  `CompensationPerson` binding path, `Retriever.ts` ranking, WS frame decoding in
  the scraper, `tg-bot` survey and admin handlers, `tg-bot/tg-bot-frontend`.
- How the manifests' declarative names (`ConversationView.v1`, `MessageSent.v1`,
  `CallStarted.v1`, …) map to code — no symbols of those names were found.
- The exact ordering of governance rebind cascades (flags verified; sequence not
  executed).
- Whether zero-importer `'use server'` files are reachable (needs a build
  manifest).
- Reader/writer completeness for tables accessed only through raw SQL.
