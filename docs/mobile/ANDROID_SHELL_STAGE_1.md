# ANDROID_SHELL_SESSION_DEEPLINK_FOUNDATION — stage 1 record

Baseline: `main` at `b49af1cf34c02cbdf1889d9b7c5dc1683854c753`.

## What this stage delivers

An installable Android shell around the existing CRM Messenger, a mobile
session lane that requires a proven credential, and a server-side gate that a
notification tap goes through. It delivers no push transport and no telephony.

## CRM_BACKEND_BLOCKER: MOBILE_AUTH_BOUNDARY

**The CRM has no authentication.** This is not an inference; it is what the
code says and what the deployment answers.

| Evidence | Where |
|---|---|
| `login()` is documented as not an authentication primitive: "there is no password / token / proof of identity" | `gravity-mvp/src/lib/users/user-service.ts` |
| Anonymous callers may assume any identity, including Администратор | `canLogin` matrix, `gravity-mvp/src/lib/users/auth-helpers.js` |
| The identity cookie is unsigned, not `httpOnly`, not `secure`, and is read from page JavaScript in five components | `login()` sets only `maxAge`; `document.cookie` reads in ChatList, ChatWorkspace, ChatHeader, ContactProfileDrawer, sip-client-context |
| There is no route guard. The Next 16 proxy blocks exactly one path | `gravity-mvp/src/proxy.ts` matcher is `/api/debug-db/:path*` |
| `GET https://yokoone.ru/messages` returns the full Messenger, HTTP 200, with no cookies | measured 2026-09-11 |
| `POST /api/messages` sends a message to a real customer with no caller check | `gravity-mvp/src/app/api/messages/route.ts` |
| The per-chat SSE stream has no caller check | `gravity-mvp/src/app/api/messages/stream/[chatId]/route.ts` |
| No external protection in front of the app: no Cloudflare Access, no basic auth, no IP allowlist | `deploy/nginx/conf.d/crm.conf` |

**Minimum contract required to clear this blocker.** It is a CRM-wide task, not
a mobile one, and it must be owned by `identity_access`:

1. A per-person credential. `CrmUser` has no password column and the runtime
   operator ids live in `src/data/users.json`; these are two disjoint
   namespaces (`schema.prisma`, `Call.managerId`). One of them must become the
   authenticated subject.
2. A request guard that fails closed for every page and API route except an
   explicit public allowlist (health, webhooks with their own signature
   checks). `gravity-mvp/src/proxy.ts` is the only existing whole-app hook.
3. Authorization on the message surfaces: `POST /api/messages`,
   `/api/messages/send-media`, `/api/messages/delete`, the per-chat SSE stream,
   and the conversations list.
4. A decision on what an operator may see. There is no per-user ACL on `Chat`
   today, so "someone else's conversation" is not yet expressible.

**What this stage did instead.** The mobile lane got its own real session, so
the app does not add a new unauthenticated surface and a lost phone does not
hand over the CRM. It does not and cannot close the browser lane.

## The mobile session

Owned by `identity_access`. Modelled on the one existing verifiable session in
the repository, `yoko_integration_admin_session`, rather than a second
independently-reasoned design.

- Cookie `yoko_mobile_session`: `httpOnly`, `secure` in production, `sameSite=lax`, 12-hour `maxAge`.
- HMAC-SHA256 over `{v, aud, sub, op, did, rev, iat, exp}`, constant-time verify.
- The signing key is derived with a lane-specific label, so a token from this
  lane cannot verify as an integration-admin token or the reverse.
- **Proven identity**: possession of a provisioned credential. A dedicated
  `MOBILE_ACCESS_USER`/`MOBILE_ACCESS_PASS` pair is preferred; until it is
  provisioned the lane falls back to the already-provisioned project-admin
  credential, so the gate is real from the first deploy. Weak, short and
  placeholder values are refused and disable the lane rather than opening it.
- **Expiry**: 12 hours, checked on every request.
- **Logout**: `clearMobileSessionV1` clears the session and the derived value.
- **Server-side revocation**, two levers, neither needing a table or a deploy:
  raise `MOBILE_SESSION_REVOCATION_EPOCH` to invalidate every device at once,
  or rotate the credential, which invalidates both lanes.

`op` is the runtime operator id from `users.json`. It is **not** a Prisma
`CrmUser.id` and nothing may use it as one. It is carried inside the signed
token; `crm_user_id` is then re-written from it on every gated request as a
derived UI value that carries no authority.

## The notification gate

`GET /messages/open?chat=<id>[&msg=<id>]`, owned by `messaging`.

The shell never builds a `/messages?id=…` URL. It hands this route an
identifier and the CRM decides the destination:

- No session → `303` to `/login/mobile?next=<this url>`, so login returns the
  operator to the conversation they tapped.
- Unknown conversation → `303` to `/messages?open=unavailable`.
- Identifier that is not `[A-Za-z0-9_-]{1,64}` → `303` to `/messages`, with no
  database lookup at all.
- The channel tab comes from the conversation's stored channel, never from the
  payload.
- `phone` and `driver` are dropped. `/messages?phone=` runs a
  `prisma.chat.create` on GET; a notification path must not reach a write.
- Every `Location` is relative. `request.url` resolves to the container
  address behind the production Nginx, so an absolute redirect would point at
  the wrong host.
- The route is read-only. Receiving or opening a notification marks nothing
  read.

## Telephony boundary

The root layout mounts `SipProvider` on every page, and `SIP_WS_URL` is set in
production, so an unmodified shell would register a second SIP endpoint for the
same extension and compete with the operator's browser for incoming calls.

`GET /api/calls/sip-credentials` now returns `{enabled: false, reason:
"mobile_shell_stage_1"}` when the request carries a mobile session, so the
provider reports "disabled" and never creates a user agent. The shell
additionally denies every `WebChromeClient.onPermissionRequest`, so it cannot
obtain a microphone even if that server decision were reverted.

## Device registration contract for the next stage (not implemented)

Push needs durable per-device state, which needs a table, which drags in the
production-migration authority machinery. That is deliberately a separate
gated stage. The shape it should take:

- **Owner**: `identity_access`. It already owns the session a registration is
  bound to, and `platform_shell` declares `owned_data: []` so it cannot own a
  table.
- **Table** `MobileDeviceRegistration`: `id`, `deviceId` (the `did` already in
  the session), `runtimeOperatorId`, `transport` (`fcm`), `token`,
  `credentialSubject`, `createdAt`, `lastSeenAt`, `revokedAt`.
- **Register**: `RegisterMobileDeviceCommand.v1`, accepted only with a valid
  mobile session, and only for the `did` inside that session. A device may not
  register a token for another device.
- **Rotate**: the same command with a new token replaces the old row for that
  `deviceId`; the previous token is deleted, not kept.
- **Revoke**: `RevokeMobileDeviceCommand.v1` on logout, on session expiry
  observed server-side, and on an epoch bump. Revocation is what makes push
  stop for a lost phone.
- **Native boundary**: `ChatNotifications.postChatNotification` is the single
  function an FCM message handler would call. Nothing else in the shell
  changes, and the payload stays `{chatId, channelTab, messageId}` — never a
  URL.
- **Fan-out hook**: `emitMessageReceived` in `gravity-mvp/src/lib/messageEvents.ts`
  is the one entry point every inbound channel goes through. It is the correct
  place for a push fan-out and was not modified in this stage.

## Still unproven

Everything on a physical device: real keyboard and inset behaviour, WebView
cookie survival across an actual process kill, notification delivery in
background and on a locked screen, and reading and replying in a real
conversation. Remote push is not implemented, so no push result can be claimed.
