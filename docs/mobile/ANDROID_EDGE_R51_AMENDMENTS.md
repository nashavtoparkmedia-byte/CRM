# Android edge Basic auth R5.1: amendments after #182

The R5.1 design for the Android shell (edge Basic auth, context reset,
continuity record) was written and reviewed before the repository moved off the
old build server. Its text, errata and test matrix are not in git and were not
recovered. The code comments that cite it (§5.3, §5.8.3, …) are what remains.

This file records every change to R5.1 made after #182 was merged into main
(1305140f). Each entry names who decided it, and it carries the same force as
the original section it amends.

## A1. Reset logout (Identity Access follow-up F-1)

**Problem.** A reset that the page did not start cleared the WebView cookies
without ending the CRM session. That covers the native «Сменить сотрудника»
button and shortcut, the operator fence, `/login` reached without logging out,
and a continuity mismatch. No logout barrier entry was written, so a copied
`yoko_mobile_session` kept working until its TTL. The page's own «Выйти» was
already correct, because it logs out through the CRM before the shell resets.

**Contract (identity_access).** `POST /api/mobile/session/logout`. The
endpoint ships in its own identity_access PR, #216 (HEAD 30bdcf05).
- The principal comes from the `yoko_mobile_session` cookie alone. The
  endpoint never authenticates.
- A JSON content type is required. No body is read, and there is no redirect.
- Every response carries `Cache-Control: no-store` and no `Location`.

| Answer | When | Shell outcome |
|---|---|---|
| `204`, empty, `Set-Cookie` with `Max-Age=0` for both cookies | a live session: push registration revoked, barrier entry written for exactly this session | LOGGED_OUT |
| `204`, empty, no `Set-Cookie`, nothing written | nothing to end: no cookie, forged, expired, older revocation epoch, already logged out, a session logout could never bar, lane not provisioned | LOGGED_OUT (the reset learns nothing more) |
| `503 {"error":"MOBILE_SESSION_LOGOUT_UNAVAILABLE"}`, `Retry-After: 5` | the barrier could not be read, or its write failed | BARRIER_FAILED, not retried |
| `415 {"error":"JSON_REQUIRED"}` / `405` | not JSON / not POST; the shell never sends either | FAILED |
| `308` | a trailing slash; the compile-time path has none | UNEXPECTED_REDIRECT, not followed |
| `401` with a Basic challenge | only the edge; the CRM never answers this path with 401 | EDGE_REFUSED |

In the shell lane `proxy.ts` lets this one exact path through without a live
session, so a dead session gets `204` there instead of the boundary's `401`.
The native request carries no shell marker and takes the other lane, which
behaves the same.

**§5.3, new step between 2 and 3.**
1. Before step 1, while the credential is still held, the reset decides the
   logout (`ResetLogout.plan`) and copies the session cookie pair and the edge
   header out for it.
2. After step 2, one native POST runs alongside steps 3–5.
3. Before step 6 the reset waits at most 3 s for it. Any answer, or none, lets
   the reset continue.
4. Unverified cookie removal still blocks, as before.

The request uses `PushRegistrar`'s wire rules: NO_PROXY, no redirects, a
compile-time path, the session cookie only, and nothing logged but the outcome.

**When it is sent.**
- It is not sent for SESSION_ENDED, for EDGE_CREDENTIAL_REFUSED, or when there
  is no session cookie.
- It is not sent when the edge gate is known and no usable credential is held
  (Variant A). This always applies to EDGE_MAX_AGE in production.
- It is not run in a pending-reset completion after process death: no
  credential is held then.

**"Nothing in-app may load or be requested from step 0" (amended).** The only
outbound request after step 0 is this native logout to the pinned endpoint. It
can only end the session it carries. `start()` makes at most one request.

**C1 (Security).** The whole request, not only the edge header, goes only to
the pinned https endpoint. A build whose origin is not https sends nothing.

**B1–B4 (Security, test-build exception for the emulator acceptance E2E).**
- **B1.** Only when `BuildConfig.IS_TEST_BUILD` is true, and only for exactly
  the compile-time endpoint on an `http://127.0.0.1` origin. No other http host
  qualifies, including the emulator's `10.0.2.2`.
- **B2.** The edge `Authorization` header is never sent there. Only the pinned
  https endpoint may carry it.
- **B3.** Release builds stay strict. `IS_TEST_BUILD = false` there is asserted
  by `CrmOriginTest`, and a JVM test asserts the release rule refuses loopback.
- **B4.** Rationale: Chromium treats loopback as a secure context, so the
  WebView itself sends the session cookie to that origin. The native request
  sends the same value only where the WebView already does.

**§5.8.3, continuity mismatch (amended, Security Q2).** The old session's
cookies leave the device in at most one further request: the reset's logout to
the pinned endpoint. This holds only while an accepted credential is held, that
is, for a mismatch decided by the probe or by rule G. A precheck mismatch, a
probe without `proceed()` (UNVERIFIED) and a gateless rule-G mismatch send
nothing.

**Decision record.**
- **Identity Access** («YOKO CRM — Identity Access — PC_Эволюция»), 2026-11-09:
  - F-1 found in its #182 Identity review;
  - endpoint contract agreed, identity_access owns the endpoint;
  - asked for a logout on a continuity mismatch.
- **Security** («Security Claude — PC»), preliminary design decision in a
  cross-session exchange with the Android session, 2026-11-09/10. It covered
  local commits 2bc6d802 → e7ddaff4 → fc34e664 and was given before the full
  PR review.
  - **Q1:** the second native request and the step-0 exception are accepted,
    on condition C1, and stay exactly one request.
  - **C1:** the whole request goes only to the pinned https endpoint.
  - **B1–B4:** the test-build loopback exception, chosen over strict C1 so
    that the full path runs in CI.
  - **Q2:** a continuity mismatch logs out only while an accepted credential
    is held. This covers both the probe/decide mismatch and the rule-G
    mismatch.
  - **§5.8.3:** amended as above.
  - **Self-limiting:** the loopback exception also requires
    `endpoint == origin + MOBILE_LOGOUT_PATH`. `CrmOriginTest` pins an https
    origin in release, so even a release build with a wrong `IS_TEST_BUILD`
    cannot reach a loopback endpoint. The PR cites both tests: B3 and «the
    shipped release origin is https».
  - The full review is bound to the Android PR on the HEAD of the
    identity_access endpoint PR.

**Tests.**
- `ResetLogoutTest` (JVM) covers the decision per reason, gate and endpoint,
  C1, B1–B3 and Q2.
- It also checks the wire against a loopback server: every row of the response
  matrix above, timeout, unreachable and proxy. B2 is checked on the wire.
- The acceptance E2E step (`ResetLogoutAcceptanceTest`, workflow step «Prove a
  reset logs the CRM session out before it forgets it») runs on a CRM built
  from the identity_access PR. It signs in on the emulator and keeps the
  session cookie on the device. Then it starts the «Выйти и сменить
  сотрудника» shortcut target and checks two things:
  - Between the reset's start and its end-process, the shell logged exactly
    one native logout, answered 204, and no other request. Page requests may
    appear there only as the shell's own 403 refusal.
  - Presented again afterwards, the kept cookie is refused:
    - native push-registration: `401 MOBILE_SESSION_REVOKED`, which comes only
      from the logout barrier;
    - shell-lane push-registration: `401 mobile_session_required`;
    - shell-lane page: `303` to `/login/mobile`.
