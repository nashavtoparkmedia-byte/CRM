package ru.yokoone.crm.shell

import android.net.Uri
import androidx.annotation.VisibleForTesting
import java.io.IOException
import java.net.HttpURLConnection
import java.net.Proxy
import java.net.URL
import java.util.concurrent.CountDownLatch

/**
 * Reset logout: before a context reset forgets the CRM session, ask the CRM to
 * log that session out, so a copy of the session cookie stops working now
 * instead of at its expiry (Identity Access follow-up to #182).
 *
 * Without it the reset only clears the WebView's cookies: no barrier entry is
 * written and the push registration stays active until the session's TTL or a
 * revocation epoch bump. The page's own «Выйти» already logs out through the
 * CRM before the shell resets; this covers every reset the page did not start.
 *
 * Contract (identity_access, `POST /api/mobile/session/logout`):
 * - the principal comes from the session cookie alone; no body is read;
 * - JSON content type required; no redirect;
 * - 204: logged out, and also for a missing, invalid, expired or already
 *   barred session (the reset learns nothing about the session);
 * - 503: the barrier write failed, so a copy of the cookie may still work.
 *
 * Best effort, and never a gate: whatever the answer, or none within
 * [WAIT_MS], the reset continues. The call runs alongside reset steps 3–5 on
 * values copied before step 1, so it never waits on, or for, cookie removal.
 *
 * The wire rules are [ru.yokoone.crm.shell.push.PushRegistrar]'s, and one more:
 * - the whole request goes only to the pinned https endpoint (Security C1): a
 *   build whose origin is not https sends nothing, so the native request can
 *   never put the session cookie where the WebView would not. The one
 *   exception is a test build's loopback origin ([allowsSessionTo], B1–B4);
 *   release stays strict;
 * - a compile-time endpoint on the pinned origin;
 * - NO_PROXY and no redirect following;
 * - the session cookie and nothing else from the jar;
 * - the staff `Authorization` header only from an accepted, unexpired
 *   credential (Variant A).
 * With the edge gate known to exist and no such credential, nothing is sent.
 * No cookie, header or response body is ever logged.
 *
 * This is the one request the shell makes from reset step 0 on, and the only
 * one in which an old session's cookie may leave the device after a
 * CONTINUITY_MISMATCH (§5.8.3 as amended by Security, Q2): there it is sent
 * only when an accepted credential is held, i.e. after the probe or rule G
 * decided the mismatch; the precheck mismatch, before any credential, sends
 * nothing.
 */
object ResetLogout {

    /** The longest the reset waits for the answer before it ends the process. */
    const val WAIT_MS = 3_000L

    private const val CONNECT_TIMEOUT_MS = 2_000
    private const val READ_TIMEOUT_MS = 2_000

    sealed interface Plan {
        data class Send(val endpoint: String, val cookiePair: String, val authorization: String?) : Plan
        data class Skip(val reason: String) : Plan
    }

    enum class Outcome { LOGGED_OUT, BARRIER_FAILED, EDGE_REFUSED, UNEXPECTED_REDIRECT, FAILED }

    /**
     * Decide before reset step 1, while the credential is still held.
     *
     * - The endpoint is not the pinned https one (C1): nothing is sent.
     * - SESSION_ENDED: the CRM already ended the session.
     * - EDGE_CREDENTIAL_REFUSED: the edge would refuse the request too.
     * - CONTINUITY_MISMATCH without an accepted credential: the precheck
     *   mismatch, where the old cookie leaves the device in no request.
     * - No session cookie: nothing to log out (e.g. after the page's «Выйти»).
     * - The edge gate is known and no usable credential is held (always the
     *   case for EDGE_MAX_AGE): Variant A sends no request without one.
     *
     * [mayCarrySession] is [allowsSessionTo]; tests that speak to a loopback
     * stub pass a wider rule.
     */
    fun plan(
        reason: String,
        cookiePair: String?,
        authorization: String?,
        gate: ContinuityGuard.EdgeGate,
        endpoint: String = endpoint(),
        mayCarrySession: (String) -> Boolean = { allowsSessionTo(it) },
    ): Plan = when {
        !mayCarrySession(endpoint) -> Plan.Skip("endpoint")
        reason == EdgeContextReset.Reason.SESSION_ENDED -> Plan.Skip("session-ended")
        reason == EdgeContextReset.Reason.EDGE_CREDENTIAL_REFUSED -> Plan.Skip("edge-refused")
        reason == EdgeContextReset.Reason.CONTINUITY_MISMATCH && authorization == null -> Plan.Skip("continuity")
        cookiePair == null -> Plan.Skip("no-session")
        authorization == null && gate == ContinuityGuard.EdgeGate.PRESENT -> Plan.Skip("edge-credential-absent")
        else -> Plan.Send(endpoint, cookiePair, authorization)
    }

    fun endpoint(): String = CrmOrigin.ORIGIN + BuildConfig.MOBILE_LOGOUT_PATH

    /**
     * C1: may the session cookie go to [endpoint] at all? Yes for the pinned
     * https endpoint. Otherwise only in a test build, and only for exactly
     * the compile-time endpoint on an `http://127.0.0.1` origin (B1); no other
     * http host, not even the emulator's 10.0.2.2, which is not loopback.
     *
     * Why that exception widens nothing (B4): Chromium treats loopback as a
     * secure context, so the WebView itself sends the session cookie to that
     * origin, Secure flag or not; the native request puts the same value only
     * where the WebView already does. The edge header never goes there (B2): [post]
     * attaches it only to the pinned https endpoint. Release builds have
     * IS_TEST_BUILD = false (asserted by CrmOriginTest) and stay strict (B3).
     */
    fun allowsSessionTo(
        endpoint: String,
        isTestBuild: Boolean = BuildConfig.IS_TEST_BUILD,
        origin: String = CrmOrigin.ORIGIN,
    ): Boolean {
        if (EdgeAuthPolicy.isPinnedHttpsEndpoint(endpoint)) return true
        if (!isTestBuild || endpoint != origin + BuildConfig.MOBILE_LOGOUT_PATH) return false
        val uri = runCatching { Uri.parse(origin) }.getOrNull() ?: return false
        return "http".equals(uri.scheme, ignoreCase = true) && uri.host == LOOPBACK_HOST
    }

    private const val LOOPBACK_HOST = "127.0.0.1"

    /**
     * Run [plan] off the main thread: at most one request, to the endpoint the
     * plan was decided for. The latch opens once the answer is in, the request
     * failed, or there was nothing to send.
     */
    fun start(plan: Plan): CountDownLatch {
        val done = CountDownLatch(1)
        when (plan) {
            is Plan.Skip -> {
                ShellDiagnostics.write("edge-reset logout skipped reason=${plan.reason}")
                done.countDown()
            }
            is Plan.Send -> Thread({
                try {
                    post(plan.endpoint, plan.cookiePair, plan.authorization)
                } finally {
                    done.countDown()
                }
            }, "yoko-reset-logout").apply { isDaemon = true }.start()
        }
        return done
    }

    /**
     * [mayAuthorize] decides whether [authorization] may be attached to
     * [endpoint]; the production rule is "https, exactly the pinned host".
     * Tests that speak to a loopback stub pass a wider rule.
     */
    @VisibleForTesting
    fun post(
        endpoint: String,
        cookiePair: String,
        authorization: String? = null,
        connectTimeoutMs: Int = CONNECT_TIMEOUT_MS,
        readTimeoutMs: Int = READ_TIMEOUT_MS,
        mayAuthorize: (String) -> Boolean = EdgeAuthPolicy::isPinnedHttpsEndpoint,
    ): Outcome {
        var connection: HttpURLConnection? = null
        val sendHeader = authorization != null && mayAuthorize(endpoint)
        val outcome = try {
            connection = (URL(endpoint).openConnection(Proxy.NO_PROXY) as HttpURLConnection).apply {
                requestMethod = "POST"
                // A redirect would put the session cookie on a URL the shell never chose.
                instanceFollowRedirects = false
                connectTimeout = connectTimeoutMs
                readTimeout = readTimeoutMs
                useCaches = false
                doOutput = true
                setRequestProperty("Content-Type", "application/json")
                setRequestProperty("Accept", "application/json")
                setRequestProperty("Cookie", cookiePair)
                if (sendHeader) setRequestProperty("Authorization", authorization)
            }
            connection.outputStream.use { it.write("{}".toByteArray(Charsets.UTF_8)) }

            when (val status = connection.responseCode) {
                204 -> Outcome.LOGGED_OUT
                503 -> Outcome.BARRIER_FAILED
                401 -> {
                    val challenge = connection.getHeaderField("WWW-Authenticate")?.trim().orEmpty()
                    if (challenge.regionMatches(0, "Basic", 0, 5, ignoreCase = true)) {
                        Outcome.EDGE_REFUSED
                    } else {
                        failed("http_401")
                    }
                }
                in 300..399 -> Outcome.UNEXPECTED_REDIRECT
                else -> failed("http_$status")
            }
        } catch (error: IOException) {
            failed(error.javaClass.simpleName)
        } finally {
            connection?.disconnect()
        }
        when (outcome) {
            Outcome.LOGGED_OUT -> ShellDiagnostics.write("YOKO_NET done POST /api/mobile/session/logout status=204")
            Outcome.FAILED -> Unit
            else -> ShellDiagnostics.write("YOKO_NET fail reset-logout ${outcome.name} edge=${if (sendHeader) "present" else "absent"}")
        }
        return outcome
    }

    private fun failed(detail: String): Outcome {
        ShellDiagnostics.write("YOKO_NET fail reset-logout FAILED $detail")
        return Outcome.FAILED
    }
}
