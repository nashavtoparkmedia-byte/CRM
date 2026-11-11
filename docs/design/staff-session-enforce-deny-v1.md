# Enforcement without a verified session: deny by default (v1)

Owner: identity_access. Status: Security DESIGN PASS WITH CONDITIONS on 44442fb5 (2026-11-11); R1, R2, N1 and N2 are applied in this change, and the rulings are recorded in §4.
Owner decision: «IDENTITY ACCESS / OWNER DECISION — ВАРИАНТ 1», item 1:
«Без подтверждённого входа доступ к защищённым функциям запрещён».
Builds on Staff Session v1.3 (`docs/design/staff-session-v1.md`) and F-1 (#216).

## 1. The gap

With `YOKO_STAFF_SESSION_ENFORCE=on`, `proxy.ts` removed `crm_user_id` from a
browser request without a session, but still **forwarded** it. Every page, route
handler and Server Action ran. Security's sweep on MAIN d3a57c30 counted 148
`'use server'` exports without their own guard, 80 of them exposed to the
browser. So, once enforcement was on, the edge Basic auth was the only gate.

## 2. Decision

When enforcement is on, the request boundary refuses a browser request that has
no verified session. Only a reviewed, pinned allowlist passes, and it passes
with no identity downstream. It is **one** check in the existing boundary,
reusing the BR-4 resolver. It is not a second authorization mechanism, and it
does not replace any domain check: no guard is removed or loosened.

### 2.1 What "verified session" means

Unchanged from BR-4: a live Staff Session (browser lane) or a live Mobile
Session (either lane). Everything else counts as session-less, including:
- no cookie;
- a forged, edited, expired, revoked or epoch-moved staff cookie (`staff_session_refused`);
- a refused mobile cookie;
- a mobile cookie together with a staff cookie;
- a bare `crm_user_id`;
- an integration-admin cookie alone (§4, D2).

### 2.2 Behaviour matrix (browser lane, `YOKO_STAFF_SESSION_ENFORCE=on`)

| Request | Answer |
|---|---|
| Live Staff Session | forwarded as its employee (unchanged) |
| Live Mobile Session (native client) | forwarded as its operator (unchanged) |
| Staff store or registry unreadable (R3) | 503 (unchanged) |
| Session-less, path+method on the allowlist (§3), no `Next-Action` | forwarded, `crm_user_id` stripped |
| Session-less, `Next-Action` = pinned sign-in action of that page (§2.3) | forwarded, `crm_user_id` stripped |
| Session-less, any other `Next-Action` | **401** `{"error":"staff_session_required"}` |
| Session-less, `/api` or `/api/*` | **401** JSON |
| Session-less, any method but GET/HEAD (no-JS form posts included) | **401** JSON |
| Session-less GET/HEAD of a page | **303** → `/login?next=<path>` |

- **Headers:** every refusal carries `Cache-Control: no-store`. A 401 never carries `Location`.
- **`next`:** the same-origin **path only**. The query string is dropped, because it may carry search text into the `Location` header and the sign-in page's access log (N1). Anything starting with `//` or containing `\` becomes `/`. `/login` ignores `next` today (it goes to `/`), but the proxy never emits an off-origin value.
- **Enforcement off:** the browser lane is byte-identical: `NextResponse.next()` without a rewrite.

### 2.3 Server actions: pinned by the build manifest

**Why the path alone is not enough.** A Server Action runs on whatever page it
is posted to (`Next-Action: <id>`):
- every action the page's worker carries runs there directly;
- for any other action, Next 16 forwards the request to a worker that has it (`selectWorkerForForwarding`), over HTTP, back through this proxy.

The worker contents in the 30bdcf05 build:
- `/login` carries 8 actions, including `queryCurrentUserV1` and `endUserSessionV1`, through TopBar in the root layout;
- `/login/mobile` carries 19, including user-service `addUser`, `deleteUser`, `updateUser` and `setStaffPassword`.

So listing `/login` alone would open every action in its worker.

**Rule.** A session-less `Next-Action` passes only when **the build's own**
`server-reference-manifest.json` maps that id, **for that page's worker**, to one of:

| Page | Lane | Worker | Actions (`file#export`) |
|---|---|---|---|
| `/login` | browser | `app/login/page` | `src/lib/users/user-service.ts#getLoginMode`, `#getSignInEmployees`, `#staffLogin` |
| `/login/mobile` | shell (§4 D3) | `app/login/mobile/page` | `src/app/login/mobile/actions.ts#submitMobileLoginAction` |

A pin applies only in its own lane. In the browser lane, `/login/mobile` is not
listed and its sign-in action gets 401.

**The sign-in list carries no contact data (R1).** `/login` used to call
`getUsers`, the full registry record: email, phone, status and `createdAt`.
Under enforcement that would be the one data read left open without a session.

- `/login` now calls `getSignInEmployees`: **active** employees only, `{ id, firstName, lastName, role }` only.
- `getUsers` stays the session holder's read (`/users`) and is **not** pinned. A session-less `getUsers` gets 401.
- With enforcement off, the visible list of `/login` loses disabled employees. They could not sign in anyway.

A pin is `file#export`: the same export name from another file is refused (R2b).
An action header on a listed machine route is refused too, because the action
check runs before the allowlist (R2a).

**Operations (N2).** The manifest is found relative to `process.cwd()`. The CRM
must therefore start from its app root: the image runs `npm run start` in
`WORKDIR /app` with `./.next`.

- **Where the manifest is read.** `next start` reads `.next/server/…` and `next dev` reads `.next/dev/server/…`. It is re-read when its mtime changes.
- **Fails closed.** A missing or unreadable manifest refuses every session-less action, so sign-in answers 401 rather than opening anything.
- **Lookups.** Ids go through `Object.hasOwn`, so `__proto__` or `constructor` match nothing.
- **Forwarding is still covered.** An id that is not pinned is refused before Next sees it. A request Next forwards for an unpinned id would come back through the proxy and be refused again.
- **The legacy action.** `login` (password-less) is not pinned. Under enforcement it refuses anyway (N-D2).
- **Effect on TopBar.** On `/login`, the root layout's `listUserIdentitiesV1` and `queryCurrentUserV1` calls now get 401. That only leaves TopBar empty on the sign-in page.

## 3. The allowlist (exact paths, methods, reasons)

The rules:
- **Exact paths only.** A `[name]` segment matches exactly **one** segment of `[A-Za-z0-9_-]{1,128}`, so the segment count is fixed and no entry is a prefix.
- **Build output** (`/_next/static`, `/_next/image`, `/favicon.ico`) never reaches the proxy. The matcher stays `'/((?!_next/static|_next/image|favicon.ico).*)'`, asserted by the test and the checker.
- **Machine routes** are listed only where the **route itself** refuses a caller without its secret, **including when the secret is unset**. Being listed is never the gate: `scripts/check-public-boundaries.mjs` fails if a listed route loses its gate call.

| Path | Methods | Caller | Own gate (pinned by the checker) |
|---|---|---|---|
| `/login` | GET, HEAD | employee | sign-in page (§2.3) |
| `/api/mobile/push-registration` | POST | Android native (no shell UA) | `registerMobilePushDeviceFromSessionV1` → 401 `MOBILE_SESSION_REVOKED` |
| `/api/mobile/session/logout` | POST | Android native (F-1) | `endMobileSessionForRequestV1`; 204 and never authenticates |
| `/api/webhooks/bot` | POST | tg-bot (docker network) | `x-bot-signature` = `BOT_CRM_SECRET` |
| `/api/webhook/telegram` | POST | tg-bot | `telegramIngressAuthorized` + `registerBotUser`: `BOT_CRM_SECRET`, refuses when unset |
| `/api/webhooks/max` | POST | max-web-scraper | `isAuthorizedMaxScraperWebhookV1`: constant-time, refuses when unset |
| `/api/webhook/max/reaction` | POST | max-web-scraper | same |
| `/api/ai-calls/sessions/[id]/state` | POST | audio bridge | `isBridgeMachineRequestAuthenticated`: strong secret, constant-time, refuses when unset |
| `/api/ai-calls/sessions/[id]/transcript-item` | POST | audio bridge | same |
| `/api/ai-calls/sessions/[id]/finalize` | POST | audio bridge | same |
| `/api/ai-calls/sessions/by-fs-uuid/[fsUuid]` | GET | audio bridge | same |
| `/api/internal/ai-call-keys` | GET | audio bridge | same |

Android (#217 owner) confirmed on 2026-11-11 that the app makes exactly two requests without the
`YokoShell/` marker: push registration and the native logout. The WebView
always carries the marker, and the CRM registers no service worker.

### 3.1 Not listed: activation blockers for their owners

Deny stays the default. Each of these answers 401 under enforcement until its
owner adds a gate that refuses when its secret is unset. Then it can be listed
as a reviewed one-line change. None of them is changed here.

| Path | Caller | Why it is not listed |
|---|---|---|
| `/api/webhooks/avito` | avito-worker | Bearer `AVITO_WEBHOOK_TOKEN` **fails open when unset** (`route.ts:44`) |
| `/api/cron/sync-scraper` | external scheduler (not in repo) | Bearer `CRON_SECRET` fails open when unset |
| `/api/monitoring/sync` | manual script | `x-cron-key` = `CRON_SECRET` fails open when unset |
| `/api/import-jobs/[id]` PATCH | max-web-scraper (`index.js:392-421`) | **no gate** |
| `/api/monitoring/fleet-check/callback` | yfs worker (today it posts to `POST /`, R-09) | no gate |
| `/api/cron/*` (8 routes) | no in-repo scheduler | no gate (`withCronLogging` only logs) |
| `/api/health`, `/api/transport/health` | ops scripts | no gate; the body carries connection ids and `lastError` text |
| `/api/health/infra` | docs (Uptime Kuma recipe) | no gate; its comment says "intentionally public". **Owner/ops decision.** Security recommends a monitor token, or GET-only with a body free of ids and error text |

Not affected:
- the Docker `HEALTHCHECK GET /` accepts any status below 500, so the 303 passes;
- `/wss-sip` is an nginx opt-out and never reaches the app.

Callers that will need a staff session or a token once enforcement is on:
- dev scripts that relied on anonymous access (`smoke_dev_simulate.js`, `smoke_ai_persistence.js`, `verify-*.ts`);
- `verify-gate.sh:113/114`, which expects 410/400 from tombstones and Avito.

**Activation blocker (Security):** two weaknesses in the gate of `/api/webhooks/bot`, a listed route. Its owner must make the comparison constant-time and refuse an empty or short `BOT_CRM_SECRET` before production activation:
- the comparison is not constant-time;
- if `BOT_CRM_SECRET` is set to an empty string, an empty header passes.

It is listed because tg-bot depends on it in production. Hardening it is recommended to its owner before activation.

## 4. Points for Security's ruling

- **D1, actions by manifest (§2.3).** The alternative was moving sign-in to route handlers and refusing every session-less action. That would change `/login` and `/login/mobile` for the enforcement-off lane too. The manifest keeps both pages byte-identical.
- **D2, integration-admin sign-in is not listed.** Under enforcement, the integration-admin session is a step-up after the personal sign-in, never a standalone session. The proxy does not consult it.
  - Listing `/settings/integrations/access` would let the shared password start from a session-less request. That contradicts the Owner's «no permanent shared-password route to personal data».
  - An employee reaches the sign-in page with their Staff Session.
- **D3, the shell lane with enforcement on.** A forged `YokoShell/` marker must not open more than the enforced browser lane: «the marker selects a stricter path, never a weaker one».
  - So, while enforcement is on, a session-less write on a shell public path is only the pinned `submitMobileLoginAction` or the exact native logout. Anything else gets 401 `mobile_session_required`.
  - GET/HEAD, the shell's 303/401/503 answers and everything with enforcement off are unchanged. Android confirmed the app uses nothing else.

### 4.1 Security rulings (2026-11-11, on 44442fb5)

- **D1 ACCEPTED.** Condition: the Heavy production-build smoke on the exact PR head shows the pins resolve in the real manifest (sign-in works) and real foreign ids get 401 on `/login` and `/messages`.
  - `check-public-boundaries.mjs --require-build` asserts that each pin resolves exactly once on its worker in the built manifest.
- **D2 ACCEPTED.** Activation-order condition: bootstrap the first Администратор credential (integration-admin step-up) **before** `YOKO_STAFF_SESSION_ENFORCE=on`.
  - With enforcement on and no Администратор credential, nobody can sign in, and recovery is turning enforcement off (an operator action).
- **D3 ACCEPTED.**
- **D4 AGREED as an activation blocker for the Owner.** Security recommends personal mobile credentials: the employee's Staff Session password at mobile sign-in, with operator = that employee. Otherwise an Owner-written accepted risk.

### 4.2 Residual

- **D4, a residual this PR does not close: the Mobile Session sign-in.** `submitMobileLoginAction` accepts the **shared** `MOBILE_ACCESS_USER`/`MOBILE_ACCESS_PASS` plus an operator chosen from the list (Android Stage 1).
  - The shell marker is client-chosen, so under enforcement this is still a shared-password route to a full operator session, and that session passes the proxy in both lanes (BR-4).
  - The Owner kept Mobile Session unchanged, and Android depends on it, so nothing here changes it.
  - Before production activation the Owner should decide between personal mobile credentials (for example, the employee's Staff Session password at mobile sign-in) and an accepted, written risk.

## 5. Proof

- **`src/lib/security/staff-session-enforce-deny.test.ts`** runs the real proxy, real signed sessions, a real registry file and a real manifest on disk, with in-memory storage. It covers:
  - enforcement off: byte-identical;
  - page 303 and `next` normalization (path only);
  - `/api` 401 and direct route calls 401;
  - action POSTs 401: foreign, unpinned (including `getUsers`), cross-page, the same export name from another file, an action header on a listed route, unknown or malformed ids, and a missing or unreadable manifest;
  - the pinned actions pass, and the manifest is re-read on a rebuild;
  - the production manifest path;
  - every allowlist entry passes with its methods and no identity, and other methods are refused;
  - neighbours and sub-paths are refused, and `[name]` takes exactly one plain segment;
  - forged, expired, revoked or epoch-moved staff cookies, a bare `crm_user_id`, an integration-admin cookie, a refused mobile cookie and two sessions all count as session-less;
  - live staff and mobile sessions, R3 503 and the shell answers are unchanged;
  - D3;
  - the session-less sign-in list: active employees only, and its bytes carry no email, phone, status or date (R1);
  - the pinned allowlist, the pinned actions and the matcher.
  
  It is added to `test:security-boundaries`, so hosted CI runs it.
- **`scripts/check-public-boundaries.mjs`** pins:
  - the matcher;
  - the allowlist (paths and methods; each entry must carry a reason);
  - exact-template matching;
  - each listed route's own gate;
  - the pinned actions;
  - `/login` reads `getSignInEmployees`, never `getUsers`, and that list stays active-only and `{ id, firstName, lastName, role }`;
  - with `--require-build`: each pin resolves once on its worker in the built manifest.
- **`tools/architecture/check-identity-boundary.mjs`** re-pins `user-service.ts` for the additive `getSignInEmployees`.
- **Mutants**, all killed:
  - allowlist widened to a prefix;
  - enforcement ignored (both ways);
  - action POST redirected;
  - refused staff cookie treated as a session;
  - any manifest action allowed;
  - pin applied on any page;
  - pin applied in the other lane;
  - pin matched by export name only (R2b);
  - allowlist checked before the action header (R2a);
  - `getUsers` pinned again;
  - `next` carrying the query;
  - `next` not normalized;
  - D3 removed;
  - allowlisted request keeps `crm_user_id`;
  - any parameter value accepted;
  - matcher narrowed;
  - non-GET page write redirected.
- **Production-build smoke under Heavy** (`next build` + `next start`, enforcement on, real build manifest):
  - sign-in works;
  - a real foreign action id on `/login` and on `/messages` gets 401;
  - pages get 303 and the API gets 401;
  - listed machine routes reach their own gate (401/403 without the secret);
  - live sessions pass;
  - shell answers are unchanged.

## 6. Out of scope

- Per-function guards of the 148 exports. Their owners fix those separately, and none is removed here.
- The PII access journal: a separate PR with its own design note.
- Production activation of `YOKO_STAFF_SESSION_ENFORCE`: separate Owner GO, after the §3.1 blockers are resolved.
