# ANDROID_SHELL_SESSION_DEEPLINK_FOUNDATION — stage 1 record

Baseline: `main` at `b49af1cf34c02cbdf1889d9b7c5dc1683854c753`.

## What this stage delivers

An installable Android shell around the existing CRM Messenger, a mobile lane
that fails closed without a provisioned credential, and a server-side gate that
a notification tap goes through. It delivers no push transport and no
telephony, and it does not establish who an operator personally is.

## CRM_BACKEND_BLOCKER: MOBILE_AUTH_BOUNDARY

**The CRM has no authentication.** This is not an inference; it is what the
code says and what the deployment answers.

| Evidence | Where |
|---|---|
| `login()` is documented as not an authentication primitive: "there is no password / token / proof of identity" | `gravity-mvp/src/lib/users/user-service.ts` |
| Anonymous callers may assume any identity, including Администратор | `canLogin` matrix, `gravity-mvp/src/lib/users/auth-helpers.js` |
| The identity cookie is unsigned, not `httpOnly`, not `secure`, and is read from page JavaScript in five components | `login()` sets only `maxAge`; `document.cookie` reads in ChatList, ChatWorkspace, ChatHeader, ContactProfileDrawer, sip-client-context |
| Before this branch there was no route guard: the Next 16 proxy matched exactly one path | `gravity-mvp/src/proxy.ts` at `b49af1cf`, matcher `/api/debug-db/:path*` |
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

**What this stage did instead.** The shell lane fails closed at the request
boundary. `gravity-mvp/src/proxy.ts` refuses every request carrying the shell's
User-Agent marker unless it presents a live mobile session, so the shell reaches
no page, no API route, no server action and no stream without one. That covers
the three concrete gaps a route-level gate left open: a saved `/messages?id=…`
restored on next launch, the twenty-six messenger API paths with no caller check
of their own, and a session that expires mid-use while the app keeps sending.

It does not and cannot close the browser lane, which remains fully open.

## UNRESOLVED: the mobile lane does not prove who the operator is

The shell authenticates possession of ONE shared credential and then shows a
list of operator names to pick from. Two people with the same password are
indistinguishable, and nothing stops either of them picking the other's name.

So the session proves **access**, not **identity**. Everything downstream of
that inherits the weakness: the `op` claim in the token, the `crm_user_id` value
derived from it, chat assignment, and any future per-recipient push routing.

This is not closed and must not be reported as closed. Closing it needs
per-person credentials, which is the same CRM-wide identity project as the
blocker above — `CrmUser` has no password column and the runtime operator ids
are a separate namespace in a JSON file. Until then, treat the mobile lane as a
device-level lock with an operator label attached, and do not use the `op` claim
for anything an auditor would need to attribute to a named person.

## The mobile session

Owned by `identity_access`. Modelled on the one existing verifiable session in
the repository, `yoko_integration_admin_session`, rather than a second
independently-reasoned design.

- Cookie `yoko_mobile_session`: `httpOnly`, `secure` in production, `sameSite=lax`, 12-hour `maxAge`.
- HMAC-SHA256 over `{v, aud, sub, op, did, rev, iat, exp}`, constant-time verify.
- The signing key is derived with a lane-specific label, so a token from this
  lane cannot verify as an integration-admin token or the reverse.
- **What it proves**: possession of `MOBILE_ACCESS_USER` and
  `MOBILE_ACCESS_PASS`. Access, not personal identity — see the unresolved
  section above. There is no fallback to the project-admin credential: a phone
  must never carry the password that unlocks integration credentials, and an
  unprovisioned or placeholder value disables mobile login rather than opening
  it.
- **Expiry**: 12 hours, checked at the request boundary on every request.
- **Logout**: `clearMobileSessionV1` clears the session and the derived value;
  the next request from the shell gets the login screen.
- **Server-side revocation**, two levers, neither needing a table or a deploy:
  raise `MOBILE_SESSION_REVOCATION_EPOCH` to invalidate every device at once, or
  rotate `MOBILE_ACCESS_PASS`. Both take effect on the shell's next request,
  with the cookie still sitting on the device.

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

`GET /api/calls/sip-credentials` returns `{enabled: false, reason:
"mobile_shell_stage_1"}` whenever the request comes from the shell, so the
provider reports "disabled" and never creates a user agent.

**Keyed on the client, not the session, and that distinction is the fix.** The
credential is otherwise granted on the strength of `crm_user_id`, which outlives
the mobile session in every direction:

| Window | Why the session check would have failed |
|---|---|
| Before login | The desktop `/login` picker writes `crm_user_id` with no credential at all |
| After 12 hours | The token expires on the server clock, the cookie on the device clock; a slow device keeps the cookie alive |
| After a revocation-epoch bump | The token dies instantly, `crm_user_id` is untouched |
| After a credential rotation | Same, and this is the case where a revoked device would have been handed a SIP password |

Denying on the client closes all four. The shell additionally denies every
`WebChromeClient.onPermissionRequest`, so it cannot obtain a microphone even if
the server decision were reverted.

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
- **Bridge**: stage 1 ships none. Nothing the page could tell the shell was
  needed, and an injected object carrying messages nothing sends is attack
  surface bought for nothing. The push stage adds exactly one operation, to
  hand the registration token to the page, using
  `WebViewCompat.addWebMessageListener` with an allowed-origin rule of the
  pinned origin — never `addJavascriptInterface`, which injects into every
  frame regardless of origin.
- **Fan-out hook — corrected.** An earlier draft of this document called
  `emitMessageReceived` (`gravity-mvp/src/lib/messageEvents.ts`) the one entry
  point every inbound channel goes through. **That was wrong**, and a push stage
  built on it would silently miss channels.

  It is reached by six call sites in three files, covering the Telegram user
  account, the current MAX webhook and the WhatsApp live path. At least four
  inbound paths create `Message` rows without it:

  | Path | Where |
  |---|---|
  | Telegram Bot channel, group and private | `src/app/api/webhook/telegram/route.ts` |
  | Avito lead intake | `src/lib/leads/intake.ts` into the receive-message adapter |
  | Legacy MAX webhook, reachable but no longer the scraper's default | `src/app/api/webhook/max/route.ts` |
  | Inbound call-timeline rows | `src/lib/freeswitch/EslClient.ts` via the call-timeline adapter |

  History importers for WhatsApp and Telegram also create inbound rows without
  emitting, while the MAX webhook's emit is guarded only on direction and so
  does fire on history replay.

  One correction to an earlier draft of this list: the MAX scraper's live
  entry point is `max-web-scraper/index.js`, which its `package.json` names as
  `main` and the Dockerfile runs, and it defaults to `/api/webhooks/max` — the
  route that does emit. `maxBrowser.js` is not the running scraper.

  Before any push work, someone must decide the hook point deliberately.
  Persistence is the narrower truth than this function.

Four things the push stage must settle, none of which exist today:

1. **Channel coverage.** Enumerate every inbound write path and prove the hook
   sees all of them, or accept named gaps in writing.
2. **Reliable delivery.** `emitMessageReceived` is fire-and-forget on an
   in-process bus; a restart drops whatever was in flight. The transactional
   outbox is declared for a single calling flow in
   `architecture/events/v1/outbox-manifest.json`, so a messaging flow needs its
   own declaration rather than a third writer on the existing one.
3. **Deduplication.** History replay, the MAX catch-up path and provider retries
   all re-deliver. A push identity key is needed so one message cannot notify a
   phone twice.
4. **Recipient permission.** `Chat.assignedToUserId` is the only routing signal
   and it is frequently null. There is no per-user ACL on `Chat`, so "who may be
   told about this conversation" is not expressible yet, and the operator
   identity that would answer it is the unresolved item above.

## Known functional cost

Hold-to-record voice messages do not work in the shell. The composer records
through `getUserMedia`, the shell denies every device-capability request, and
the CRM swallows the rejection, so the button does nothing visible. Typed
messages, photo and file attachments are unaffected.

This was a choice, not an oversight. Granting audio means declaring
`RECORD_AUDIO` and prompting for the microphone on a CRM app whose next stage
is telephony, at exactly the moment the shell must not suggest it handles
calls. Re-enabling it later is small: declare the permission, request it on
first use, and grant only `RESOURCE_AUDIO_CAPTURE`.

## Still unproven

Everything on a physical device: real keyboard and inset behaviour, WebView
cookie survival across an actual process kill, notification delivery in
background and on a locked screen, and reading and replying in a real
conversation. Remote push is not implemented, so no push result can be claimed.

## Acceptance on a phone

**Installing an APK adds no server routes.** `/login/mobile` and
`/messages/open` exist only in a backend running this branch, and the request
boundary that closes the shell lane is part of it too. Production does not have
them, and production has no `MOBILE_ACCESS_*` provisioned, so the
production-origin build cannot log in. Acceptance runs against a disposable
backend:

```
bash android/tools/run-acceptance-backend.sh
```

It starts its own PostgreSQL container, applies this branch's schema, seeds
three synthetic conversations, and prints the LAN origin plus the exact command
to build the matching APK. `--stop` removes the database. It never touches
production and leaves `SIP_WS_URL` unset, so no telephony can start.

Build and install the matching artifact it names, then:

1. Install the APK. Android will warn about an unknown source; allow it.
2. Open the app. It must show the mobile login screen, not the Messenger.
   Reaching the Messenger without logging in would mean the request boundary is
   not active.
3. Enter a wrong password. It must say the login or password is wrong and stay
   on the screen.
4. Enter the real credential, pick your name from the list, sign in. The
   Messenger opens on the conversation list.
5. Open a conversation, read it, send a reply. Check the reply arrives in the
   customer's messenger.
6. Check the keyboard: the composer must stay visible above it, and the system
   Back button must close the conversation rather than the app.
7. Press Back from the conversation list. The app closes. Reopen it: it must
   return you where you were without asking to log in again.
7a. Ask whoever runs the backend to raise `MOBILE_SESSION_REVOCATION_EPOCH` and
   restart it. Your next action in the app must land on the login screen, with
   nothing sendable in between.
8. Pull down the notification shade. There is a permanent "YOKO CRM · проверка
   перехода" entry with a button. With a conversation open, press that button.
9. Put the app in the background, then tap the notification that appeared. The
   app must open that exact conversation, with the right channel tab selected.
10. Repeat steps 8 and 9 with a second conversation. Two separate
    notifications must exist and each must open its own conversation.
11. Swipe the app away from recents, then tap a notification. It must still
    open the right conversation.
12. Confirm no call ever rings in the app, and that incoming calls keep
    arriving on the desktop CRM as before.

Report anything that behaves differently from the step text.
