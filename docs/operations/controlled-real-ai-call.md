# Controlled real AI call

This runbook covers the source-side gate for exactly one authorized,
allowlisted real AI call. It does not authorize deployment, provider account
changes, billing activation, number purchase, or a real call by itself.

## Boundary

The operator-facing API is `GET/POST /api/ai-calls/start`. Only active users
with role `Администратор` or `Руководитель` can use it, and the request must
also carry the separately generated `X-Controlled-Real-Call-Token`. The token
is required because the current CRM identity cookie is not a strong
authentication primitive.

The flow is:

1. Calling resolves one Contact, Driver, or explicit E.164 recipient.
2. Calling checks the resolved E.164 against one exact configured destination.
3. Calling creates the canonical non-simulation `Call` before provider dispatch.
4. The Calling FreeSWITCH adapter originates one Megafon trunk leg.
5. Authenticated AudioBridge callbacks enter the canonical Calling lifecycle,
   transcript, and finalization operations.
6. The existing call detail page shows status, recording, transcript, outcome,
   and failure fields as they become available.

Campaign execution cannot enter this endpoint. The campaign runtime remains
simulation-only and has no live adapter selection.

## Required configuration

Every predicate below is fail-closed. Values must be supplied explicitly; the
live path has no caller-number, ESL credential, dial-template, or park-extension
defaults.

| Variable | Required value / rule |
| --- | --- |
| `AI_CALL_LIVE_MODE` | Exact string `true`; primary live kill switch |
| `AI_CALL_CONTROLLED_REAL_CALL_ENABLED` | Exact string `true`; single-call gate |
| `AI_CALL_CONTROLLED_OPERATOR_TOKEN` | Separate high-entropy token (for example `openssl rand -base64 48`); sent in `X-Controlled-Real-Call-Token` |
| `AI_CALL_CONTROLLED_REQUEST_ID` | The one owner-approved request identity; 16–128 safe characters |
| `AI_CALL_TELEPHONY_PROVIDER` | Exact string `freeswitch` |
| `AI_CALL_CONTROLLED_DESTINATION_E164` | The one allowed test destination in strict E.164 |
| `AI_CALL_DIAL_STRING_TEMPLATE` | Exact string `sofia/gateway/megafon/${number}` |
| `MEGAFON_NUMBER` | Configured caller ID in strict E.164 |
| `FS_ESL_HOST` | Non-empty FreeSWITCH host |
| `FS_ESL_PORT` | Integer `1..65535` |
| `FS_ESL_PASSWORD` | High-entropy value, at least 16 characters, no placeholder/default; production Compose maps external `ESL_PASSWORD` into this runtime name |
| `AI_CALL_PARK_EXT` | Exact reviewed AudioBridge extension `9999` |
| `BRIDGE_SHARED_TOKEN` | High-entropy 32–172 character bridge machine token; placeholders and low-entropy test values are rejected |
| `AI_CALL_STT_PROVIDER` | Explicit `openai` or `yandex` |
| `AI_CALL_TTS_PROVIDER` | Explicit `openai` or `yandex` |
| `AUDIO_BRIDGE_HEALTH_URL` | Exact internal URL `http://audio-bridge:3030/health` |
| `RECORDINGS_HOST_PATH` | Exact mounted path `/app/freeswitch-recordings` |

OpenAI must be configured because the current dialog LLM is OpenAI. Selecting
OpenAI for STT/TTS uses that credential. Selecting Yandex for STT or TTS also
requires both the Yandex API key and folder ID. Credentials may come from the
existing encrypted provider settings or their supported environment fallback.
For a controlled real call, every selected provider must additionally have a
successful settings connectivity check no older than 24 hours. An env-only key
without durable check evidence is intentionally not sufficient.

The live preflight additionally requires the Calling ESL runtime to be
connected, the Megafon gateway state to be exactly `REGED`, and the
AudioBridge `/health` response to be exactly `ok`. Production Compose publishes
the bridge only on host loopback (`127.0.0.1:3030`) so host-network FreeSWITCH
can reach `ws://127.0.0.1:3030/audio` without exposing the bridge publicly.

## Readiness and controlled request

First call `GET /api/ai-calls/start` with the control-token header. The response is secret-free and
non-cacheable. A `200` with `ready: true` is required. A `503` lists bounded
blocker codes and does not mutate data or contact the provider.

The POST body must contain exactly one of `contactId`, `driverId`, or
`phoneNumber`, plus an explicit scenario, confirmation phrase, and a fresh
idempotency identity:

```json
{
  "requestId": "the-exact-AI_CALL_CONTROLLED_REQUEST_ID",
  "confirmation": "PLACE_ONE_CONTROLLED_REAL_AI_CALL",
  "scenarioId": "the-reviewed-scenario-id",
  "phoneNumber": "+79990000000"
}
```

Do not use the example number. It must equal
`AI_CALL_CONTROLLED_DESTINATION_E164` after owner resolution.

The configured request identity is a global one-shot budget. Calling derives
one deterministic canonical Call ID from it and atomically claims that ID; a
fresh client-supplied request ID is rejected. An exact replay by the original
operator returns the existing canonical Call with
`duplicate: true` and `dispatched: false`. Reusing the identity for another
target, scenario, or operator returns `409 idempotency_conflict`. Authorizing a
later call requires an explicit owner change of the configured request ID.

A definitive pre-send failure or FreeSWITCH rejection becomes canonical
`failed` state with `PROVIDER_ORIGINATE_FAILED`. A timeout/socket failure after
the originate command was sent is different: the Call stays nonterminal with
durable `dispatchState=outcome_unknown`, the API returns
`provider_outcome_unknown`, and retry is forbidden. This leaves the canonical
lifecycle open for genuine late callbacks. Do not rotate the request identity
after an ambiguous outcome until the operator has inspected the Call,
FreeSWITCH, and provider records.

## Stop procedure

Set either `AI_CALL_CONTROLLED_REAL_CALL_ENABLED` or `AI_CALL_LIVE_MODE` to a
value other than exact `true`, then restart/reload the application according to
the deployment runbook. Confirm the readiness endpoint returns `503` before any
further test. This source change does not perform that operational mutation.
