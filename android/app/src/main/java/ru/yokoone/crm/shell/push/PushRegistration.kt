package ru.yokoone.crm.shell.push

import android.content.Context
import androidx.annotation.VisibleForTesting
import ru.yokoone.crm.shell.CrmOrigin
import ru.yokoone.crm.shell.ShellDiagnostics

/**
 * When the device asks the CRM to remember it, and when it does not.
 *
 * Three events can start a registration and nothing else may:
 *
 *  1. the token actor commits a token the provider holds (R5.1 §5.7.2: the
 *     provider's callbacks only signal the actor, which re-reads the provider);
 *  2. the shell observes the WebView settle on an authenticated CRM page having
 *     not been on one before, in this process or since the last logout;
 *  3. the edge gate accepted the staff credential in the foreground, or the
 *     activity returned to the foreground with an accepted credential
 *     ([onEdgeReady], R5.1 §4.1 item 6).
 *
 * The second is the subtle one. Ordinary navigation between authenticated pages
 * must not enqueue anything — the operator moving between conversations is not
 * new information, and treating it as such would turn a single refusal into a
 * request per page view. But a login IS new information, even with a token that
 * has not changed by a byte, because P1 binds the registration to the session
 * that carried it: after a logout the server has revoked this device, and only
 * a new authenticated session can undo that. Waiting for a token rotation to
 * notice would be waiting for an event that may never come.
 *
 * The observation itself is deliberately shallow. It reads whether a session
 * cookie exists for the pinned origin and whether the page is the login screen.
 * It does not read the cookie value, does not store it, does not hash it, and
 * cannot tell one session from another. The durable counter in PushTokenState
 * carries the distinction instead.
 */
object PushRegistration {

    /** How an enqueue actually happens; replaced in tests so state can be proved alone. */
    fun interface Scheduler {
        fun schedule(context: Context, generation: Long, token: String)
    }

    @Volatile
    @VisibleForTesting
    var scheduler: Scheduler = Scheduler { context, generation, token ->
        PushRegistrationWorker.enqueue(context, generation, token)
    }

    /**
     * Whether the last settled page was authenticated, or null before the first
     * observation in this process.
     *
     * Process-scoped on purpose: after a cold start the shell has no idea
     * whether the session it finds is the one it last registered under, so the
     * first authenticated page of a process is treated as a new generation and
     * costs exactly one registration attempt. That is the cheapest way to
     * recover from a revocation this device never saw.
     */
    @Volatile
    private var lastAuthenticatedObservation: Boolean? = null

    /**
     * How many times the shell has looked, this process.
     *
     * Zero in a state report means the observation hook never fired at all,
     * which is a different defect from observing an unauthenticated page, and
     * the two were indistinguishable in the first hosted run.
     */
    @Volatile
    var observations: Int = 0
        private set

    @VisibleForTesting
    fun forgetProcessObservation() {
        lastAuthenticatedObservation = null
        observations = 0
    }

    /**
     * The provider says it has a token. A signal only: the value is not stored
     * or passed on; the token actor reads the provider and commits (§5.7.2).
     */
    fun onNewToken(context: Context, token: String) {
        if (token.isEmpty()) return
        TokenActor.signalRefresh(context.applicationContext)
    }

    /** Edge accepted in the foreground, or onStart with an accepted credential. Idempotent. */
    fun onEdgeReady(context: Context) {
        requestIfNeeded(context, PushTokenState.snapshot(context))
    }

    /**
     * A page finished loading. Returns true when this started a new session
     * generation, so the caller can persist the cookie jar for a registration
     * that may run in a later process.
     */
    fun onPageSettled(context: Context, url: String?, cookieHeader: String?): Boolean {
        observations += 1
        val authenticated = isAuthenticatedPage(url, cookieHeader)
        val previous = lastAuthenticatedObservation
        lastAuthenticatedObservation = authenticated

        // Not authenticated: the login screen, or a session that has gone.
        // Recorded so the next authenticated page is seen as a transition.
        if (!authenticated) return false

        // Authenticated, and already was: ordinary navigation. Nothing to do.
        if (previous == true) return false

        requestIfNeeded(context, PushTokenState.startSessionGeneration(context))
        return true
    }

    @VisibleForTesting
    fun isAuthenticatedPage(url: String?, cookieHeader: String?): Boolean {
        val target = url ?: return false
        if (!CrmOrigin.isInAppUrl(target)) return false
        if (target.contains(CrmOrigin.LOGIN_PATH)) return false
        return PushRegistrar.sessionCookiePair(cookieHeader) != null
    }

    fun requestIfNeeded(context: Context, state: PushTokenState.Snapshot) {
        val token = state.newestToken
        if (!state.needsRegistration || token == null) {
            // Silence here used to be ambiguous: a device that never asked and a
            // CRM that never answered look the same from outside. The derived
            // state says which, and carries no token or session value.
            ShellDiagnostics.write(
                "YOKO_NET fail push-enqueue skipped" +
                    " token=${token != null}" +
                    " generation=${state.sessionGeneration}" +
                    " registered=${state.isRegistered}" +
                    " blocked=${state.blockedReason ?: "none"}",
            )
            return
        }
        ShellDiagnostics.write("YOKO_NET done POST push-enqueue generation=${state.sessionGeneration}")
        scheduler.schedule(context.applicationContext, state.sessionGeneration, token)
    }
}
