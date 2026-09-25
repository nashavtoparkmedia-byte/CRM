package ru.yokoone.crm.shell.push

import android.content.Context

/**
 * Everything the shell durably knows about its own push registration.
 *
 * The state is deliberately NOT "which token did we send". P1 binds a
 * registration to the mobile session that carried it: logging out revokes the
 * device's registration server-side, and logging back in creates a session that
 * has never seen this token. If registration were keyed on the token alone, an
 * operator who logged out and back in on the same handset would stay silently
 * unregistered until Firebase happened to rotate a token — which it may never
 * do. So registration is keyed on the pair (token, session generation).
 *
 * The session generation is a local counter, not a session identifier. It is
 * incremented when the shell observes the WebView reach an authenticated CRM
 * page having previously not been on one. Nothing about the session itself is
 * stored: no cookie, no hash of a cookie, no verifier, no expiry. The counter
 * says only "the thing that was true before is no longer the thing that is true
 * now", which is all the registration path needs to know.
 *
 * Blocks are reason-specific on purpose:
 *
 *  - a session problem (required, revoked, reissue required) and an unstable
 *    device id are fixed only by a new authenticated session, so a new token
 *    inside the same generation must NOT retry them;
 *  - a token bound to another device is a property of the token, so a
 *    genuinely different token may retry it inside the same generation.
 *
 * Blocks are never erased eagerly. A newer generation makes them inapplicable
 * by mismatch, which keeps one derivation rather than two code paths.
 */
object PushTokenState {

    const val PREFS_NAME = "yoko_push_registration"

    private const val KEY_NEWEST_TOKEN = "newest_token"
    private const val KEY_REGISTERED_TOKEN = "registered_token"
    private const val KEY_REGISTERED_GENERATION = "registered_generation"
    private const val KEY_SESSION_GENERATION = "session_generation"
    private const val KEY_BLOCKED_REASON = "blocked_reason"
    private const val KEY_BLOCKED_GENERATION = "blocked_generation"
    private const val KEY_BLOCKED_TOKEN = "blocked_token"

    /** No generation yet; distinct from any real generation, which starts at 1. */
    const val NO_GENERATION = 0L

    /** Refusals that only a new authenticated session can resolve. */
    val GENERATION_SCOPED_REASONS: Set<String> = setOf(
        "MOBILE_SESSION_REQUIRED",
        "MOBILE_SESSION_REVOKED",
        "MOBILE_SESSION_REISSUE_REQUIRED",
        "PUSH_DEVICE_ID_NOT_STABLE",
        // Local, not from the server: the cookie was gone by the time the
        // worker ran. Same class of problem, same cure.
        "NO_SESSION_COOKIE",
    )

    /** The one refusal a different token can resolve on its own. */
    const val TOKEN_SCOPED_REASON = "PUSH_TOKEN_BOUND_TO_OTHER_DEVICE"

    /**
     * Serialises every read-modify-write in this process.
     *
     * The registration worker may still be in flight when a new token or a new
     * session generation arrives; the pair of them must never interleave inside
     * one decision. Held only around SharedPreferences work, never around the
     * network call.
     */
    private val LOCK = Any()

    data class Snapshot(
        val newestToken: String?,
        val registeredToken: String?,
        val registeredGeneration: Long,
        val sessionGeneration: Long,
        val blockedReason: String?,
        val blockedGeneration: Long,
        val blockedToken: String?,
    ) {

        /** True when the newest token is registered under the current session. */
        val isRegistered: Boolean
            get() = newestToken != null &&
                newestToken == registeredToken &&
                registeredGeneration == sessionGeneration &&
                sessionGeneration != NO_GENERATION

        /** True when a recorded refusal still applies to what we would send now. */
        val isBlocked: Boolean
            get() {
                val reason = blockedReason ?: return false
                if (blockedGeneration != sessionGeneration) return false
                return if (reason == TOKEN_SCOPED_REASON) blockedToken == newestToken else true
            }

        /** The one condition under which work may be enqueued. */
        val needsRegistration: Boolean
            get() = newestToken != null &&
                sessionGeneration != NO_GENERATION &&
                !isRegistered &&
                !isBlocked

        fun isCurrent(generation: Long, token: String): Boolean =
            generation == sessionGeneration && token == newestToken
    }

    private fun prefs(context: Context) =
        context.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    fun snapshot(context: Context): Snapshot = synchronized(LOCK) { read(context) }

    private fun read(context: Context): Snapshot {
        val store = prefs(context)
        return Snapshot(
            newestToken = store.getString(KEY_NEWEST_TOKEN, null),
            registeredToken = store.getString(KEY_REGISTERED_TOKEN, null),
            registeredGeneration = store.getLong(KEY_REGISTERED_GENERATION, NO_GENERATION),
            sessionGeneration = store.getLong(KEY_SESSION_GENERATION, NO_GENERATION),
            blockedReason = store.getString(KEY_BLOCKED_REASON, null),
            blockedGeneration = store.getLong(KEY_BLOCKED_GENERATION, NO_GENERATION),
            blockedToken = store.getString(KEY_BLOCKED_TOKEN, null),
        )
    }

    /**
     * Record the newest token the provider has given us.
     *
     * A new token never clears a recorded refusal. Whether the refusal still
     * applies is derived, not decided here: a token-bound conflict stops
     * applying because the token changed, and a session refusal keeps applying
     * because the session did not.
     */
    fun rememberToken(context: Context, token: String): Snapshot = synchronized(LOCK) {
        prefs(context).edit().putString(KEY_NEWEST_TOKEN, token).commit()
        read(context)
    }

    /** Begin a new authenticated session generation and return the snapshot. */
    fun startSessionGeneration(context: Context): Snapshot = synchronized(LOCK) {
        val next = read(context).sessionGeneration + 1
        prefs(context).edit().putLong(KEY_SESSION_GENERATION, next).commit()
        read(context)
    }

    /**
     * Apply a successful registration, but only if it is still the one we want.
     *
     * The check and the write are one critical section: a worker that returns
     * after a newer token or a newer session has taken over must change
     * nothing at all, and "nothing at all" has to include the case where the
     * takeover happens between the check and the commit.
     *
     * The registered token and the generation it was registered under are
     * written together. Neither is meaningful without the other.
     */
    fun applyRegisteredIfCurrent(context: Context, generation: Long, token: String): Boolean =
        synchronized(LOCK) {
            if (!read(context).isCurrent(generation, token)) return false
            prefs(context).edit()
                .putString(KEY_REGISTERED_TOKEN, token)
                .putLong(KEY_REGISTERED_GENERATION, generation)
                .remove(KEY_BLOCKED_REASON)
                .remove(KEY_BLOCKED_GENERATION)
                .remove(KEY_BLOCKED_TOKEN)
                .commit()
            true
        }

    /** Apply a terminal refusal, under the same currency rule. */
    fun applyBlockIfCurrent(context: Context, generation: Long, token: String, reason: String): Boolean =
        synchronized(LOCK) {
            if (!read(context).isCurrent(generation, token)) return false
            prefs(context).edit()
                .putString(KEY_BLOCKED_REASON, reason)
                .putLong(KEY_BLOCKED_GENERATION, generation)
                .putString(KEY_BLOCKED_TOKEN, token)
                .commit()
            true
        }
}
