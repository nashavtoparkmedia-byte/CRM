package ru.yokoone.crm.shell.push

import android.content.Context
import androidx.annotation.VisibleForTesting
import ru.yokoone.crm.shell.CrmOrigin

/**
 * When the device asks the CRM to remember it, and when it does not.
 *
 * Two events can start a registration and nothing else may:
 *
 *  1. the provider hands over a token, either the one it already had at process
 *     start or a rotated one;
 *  2. the shell observes the WebView settle on an authenticated CRM page having
 *     not been on one before, in this process or since the last logout.
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

    @VisibleForTesting
    fun forgetProcessObservation() {
        lastAuthenticatedObservation = null
    }

    /** The provider has a token for this installation. Idempotent. */
    fun onNewToken(context: Context, token: String) {
        if (token.isEmpty()) return
        requestIfNeeded(context, PushTokenState.rememberToken(context, token))
    }

    /**
     * A page finished loading. Returns true when this started a new session
     * generation, so the caller can persist the cookie jar for a registration
     * that may run in a later process.
     */
    fun onPageSettled(context: Context, url: String?, cookieHeader: String?): Boolean {
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

    private fun requestIfNeeded(context: Context, state: PushTokenState.Snapshot) {
        if (!state.needsRegistration) return
        val token = state.newestToken ?: return
        scheduler.schedule(context.applicationContext, state.sessionGeneration, token)
    }
}
