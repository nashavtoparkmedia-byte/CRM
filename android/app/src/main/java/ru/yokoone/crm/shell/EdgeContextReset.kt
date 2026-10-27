package ru.yokoone.crm.shell

import android.net.Uri
import ru.yokoone.crm.shell.push.PushTokenState

/**
 * Edge context reset (R5.1 §5): reasons, the loop guard and the verified cookie
 * removal, as pure pieces MainActivity drives.
 *
 * The sequence itself (step 0 durable intent → in-memory → stop traffic →
 * verified cookie removal → WebView stores → app state → token delete → process
 * end through the `:reset` trampoline) runs in MainActivity because it needs
 * the WebView; step 0 is [PushTokenState.beginReset], one commit under
 * [PushTokenState.LOCK].
 */
object EdgeContextReset {

    object Reason {
        const val OPERATOR_SWITCH = "OPERATOR_SWITCH"
        const val SESSION_ENDED = "SESSION_ENDED"
        const val EDGE_CREDENTIAL_REFUSED = "EDGE_CREDENTIAL_REFUSED"
        const val EDGE_MAX_AGE = "EDGE_MAX_AGE"
        const val CONTINUITY_MISMATCH = "CONTINUITY_MISMATCH"

        val ALL = setOf(OPERATOR_SWITCH, SESSION_ENDED, EDGE_CREDENTIAL_REFUSED, EDGE_MAX_AGE, CONTINUITY_MISMATCH)

        /** Subject to the 60 s guard (§5.5). OPERATOR_SWITCH from the app is always allowed. */
        val AUTOMATIC = setOf(SESSION_ENDED, EDGE_CREDENTIAL_REFUSED, EDGE_MAX_AGE, CONTINUITY_MISMATCH)

        /** A reason from an untrusted place (an Intent extra) reduced to a known name for a log line. */
        fun sanitize(value: String?): String = if (value != null && value in ALL) value else "unknown"
    }

    const val GUARD_WINDOW_MS = 60_000L
    const val COOKIE_ROUNDS = 5
    const val COOKIE_CALLBACK_TIMEOUT_MS = 2_000L
    const val TOKEN_DELETE_WAIT_MS = 5_000L
    const val TRAMPOLINE_WAIT_MS = 3_000L

    /**
     * §5.5: an automatic reset is skipped if another reset happened less than
     * 60 s earlier, by either clock. A negative delta (reboot, clock change)
     * says nothing and is ignored for that clock.
     */
    fun automaticAllowed(last: PushTokenState.LastReset?, nowWallMs: Long, nowElapsedMs: Long): Boolean {
        if (last == null) return true
        val wallDelta = nowWallMs - last.wallMs
        val elapsedDelta = nowElapsedMs - last.elapsedMs
        val recentByWall = wallDelta in 0 until GUARD_WINDOW_MS
        val recentByElapsed = elapsedDelta in 0 until GUARD_WINDOW_MS
        return !(recentByWall || recentByElapsed)
    }

    /** The cookie store, as far as the reset needs it. */
    interface CookieJar {
        fun removeAll(done: () -> Unit)
        fun flush()
        fun cookiesFor(url: String): String?
    }

    /** The `www` alias of the pinned origin; cookies are verified for both. */
    fun wwwAliasUrl(origin: String = CrmOrigin.ORIGIN): String {
        val uri = Uri.parse(origin)
        return uri.buildUpon().encodedAuthority("www." + uri.encodedAuthority).build().toString()
    }

    /**
     * Step 3 / §5.3a: verified, not timed. Up to [rounds] rounds of
     * removeAll → (callback or 2 s) → flush → read both origins; success only
     * when both are empty. [schedule] runs a block after a delay on the caller's
     * thread.
     */
    fun verifyCookieRemoval(
        jar: CookieJar,
        schedule: (Long, () -> Unit) -> Unit,
        onResult: (Boolean) -> Unit,
        rounds: Int = COOKIE_ROUNDS,
        callbackTimeoutMs: Long = COOKIE_CALLBACK_TIMEOUT_MS,
        origin: String = CrmOrigin.ORIGIN,
    ) {
        val alias = wwwAliasUrl(origin)
        fun round(index: Int) {
            var advanced = false
            val check: () -> Unit = {
                if (!advanced) {
                    advanced = true
                    jar.flush()
                    val clean = jar.cookiesFor(origin).isNullOrEmpty() && jar.cookiesFor(alias).isNullOrEmpty()
                    when {
                        clean -> onResult(true)
                        index + 1 >= rounds -> onResult(false)
                        else -> round(index + 1)
                    }
                }
            }
            jar.removeAll { schedule(0L, check) }
            schedule(callbackTimeoutMs, check)
        }
        round(0)
    }
}
