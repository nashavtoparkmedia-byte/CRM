package ru.yokoone.crm.shell.push

import android.content.Context
import android.content.SharedPreferences
import androidx.annotation.VisibleForTesting
import ru.yokoone.crm.shell.ContinuityGuard
import ru.yokoone.crm.shell.ShellKeys
import java.security.MessageDigest

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
 *
 * Edge Basic-auth design R5.1 adds, in this same file so that reset step 0 is
 * one commit (§5.3, §5.7, §5.8.2):
 *
 *  - `reset_pending`, `push_display_allowed`, `reset_epoch`, `last_reset_*`;
 *  - the token rotation state: `token_rotation_pending`, the retired-token
 *    hashes under `K_install` and the key generation that produced them;
 *  - the registration ticket counters `(resetEpoch, generation, token, seq)`
 *    and the bounded 409 recovery;
 *  - `edge_gate` and the continuity record.
 *
 * Every read-modify-write takes [LOCK], and [LOCK] is the only lock any of
 * these paths ever holds (§5.7.3a "Ordering").
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

    private const val KEY_RESET_PENDING = "reset_pending"
    private const val KEY_DISPLAY_ALLOWED = "push_display_allowed"
    private const val KEY_RESET_EPOCH = "reset_epoch"
    private const val KEY_LAST_RESET_WALL = "last_reset_wall"
    private const val KEY_LAST_RESET_ELAPSED = "last_reset_elapsed"
    private const val KEY_LAST_RESET_REASON = "last_reset_reason"
    private const val KEY_ROTATION_PENDING = "token_rotation_pending"
    private const val KEY_ROTATION_PENDING_SINCE = "token_rotation_pending_since"
    private const val KEY_ROTATION_NOTICE_SHOWN = "token_rotation_notice_shown"
    private const val KEY_RECOVER_KEY_PENDING = "install_key_recovery_pending"
    private const val KEY_RETIRED_HASHES = "retired_token_hashes"
    private const val KEY_RETIRED_SET_KEY_ID = "retired_set_key_id"
    private const val KEY_DELETE_CONFIRMED_AT = "token_delete_confirmed_at"
    private const val KEY_TICKET_SEQ = "ticket_seq"
    private const val KEY_APPLIED_TICKET_SEQ = "applied_ticket_seq"
    private const val KEY_REGISTERED_TICKET_SEQ = "registered_ticket_seq"
    private const val KEY_REGISTERED_EPOCH = "registered_epoch"
    private const val KEY_RECOVERY_GENERATION = "rotation_recovery_generation"
    private const val KEY_CONFLICT_GENERATION = "blocked_token_conflict_generation"
    private const val KEY_CONFLICT_NOTICE_GENERATION = "token_conflict_notice_generation"
    private const val KEY_EDGE_GATE = "edge_gate"
    private const val KEY_CTX_BODY = "crm_ctx_body"
    private const val KEY_CTX_MAC = "crm_ctx_mac"
    private const val KEY_CTX_KEY_ID = "crm_ctx_key_id"
    private const val KEY_SHORTCUT_RESETS = "shortcut_resets"

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

    /** Retired-token hash domain (§5.7.1). */
    private const val RETIRED_PREFIX = "yoko.fcm.retired.v1"

    /** FIFO length of the retired set. */
    const val RETIRED_CAPACITY = 8

    private const val ROTATION_NOTICE_AFTER_MS = 24L * 60 * 60 * 1000
    private const val SHORTCUT_WINDOW_MS = 10L * 60 * 1000
    private const val SHORTCUT_LIMIT = 3

    /**
     * Serialises every read-modify-write in this process.
     *
     * The registration worker may still be in flight when a new token or a new
     * session generation arrives; the pair of them must never interleave inside
     * one decision. Held only around SharedPreferences work, never around the
     * network call or a provider call. Reset step 0, the token actor's queue and
     * commits, ticket capture and result application all take this lock and no
     * other, so there is one total order of state transitions.
     */
    internal val LOCK = Any()

    data class Snapshot(
        val newestToken: String?,
        val registeredToken: String?,
        val registeredGeneration: Long,
        val sessionGeneration: Long,
        val blockedReason: String?,
        val blockedGeneration: Long,
        val blockedToken: String?,
        val resetPending: String? = null,
        val displayAllowed: Boolean = true,
        val rotationPending: Boolean = false,
        val resetEpoch: Long = 0L,
        val conflictBlockedGeneration: Long = NO_GENERATION,
        val installKeyRecoveryPending: Boolean = false,
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
                if (conflictBlockedGeneration != NO_GENERATION && conflictBlockedGeneration == sessionGeneration) return true
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

    /** `(resetEpoch, generation, token, seq)`; captured under [LOCK] right before the request. */
    data class Ticket(val resetEpoch: Long, val generation: Long, val token: String, val seq: Long) {
        override fun toString(): String = "Ticket(epoch=$resetEpoch, generation=$generation, seq=$seq)"
    }

    sealed interface Capture {
        data class Captured(val ticket: Ticket) : Capture
        data class Deferred(val reason: String) : Capture
        data object Superseded : Capture
    }

    enum class ConflictResult { STALE, RECOVER, BLOCKED }

    enum class CommitKind { REFRESH, ROTATE, RETIRE_AND_ROTATE, RECOVER_KEY }

    sealed interface CommitResult {
        data class Committed(val changed: Boolean, val snapshot: Snapshot) : CommitResult
        data class Rejected(val reason: String) : CommitResult
    }

    data class LastReset(val wallMs: Long, val elapsedMs: Long, val reason: String)

    data class StoredRecord(
        val body: String?,
        val mac: String?,
        val keyAlias: String?,
        val resetEpoch: Long,
        val generation: Long,
    )

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
            resetPending = store.getString(KEY_RESET_PENDING, null),
            displayAllowed = store.getBoolean(KEY_DISPLAY_ALLOWED, true),
            rotationPending = store.getBoolean(KEY_ROTATION_PENDING, false),
            resetEpoch = store.getLong(KEY_RESET_EPOCH, 0L),
            conflictBlockedGeneration = store.getLong(KEY_CONFLICT_GENERATION, NO_GENERATION),
            installKeyRecoveryPending = store.getBoolean(KEY_RECOVER_KEY_PENDING, false),
        )
    }

    /**
     * Record the newest token, unconditionally.
     *
     * Production code never calls this: the token actor commits through
     * [commitToken], which applies the R5.1 compare-and-set. It remains the
     * primitive the state tests build fixtures with.
     */
    @VisibleForTesting
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

    // ── registration tickets (§5.7.3, §5.7.3a, §5.7.4) ─────────────────────

    /**
     * Capture a ticket, or say why no request may be sent.
     *
     * The gates run in the order of §4.1 item 8 and each writes nothing:
     * RESET_PENDING · CONTINUITY_PENDING · TOKEN_ROTATION_PENDING /
     * TOKEN_ACTOR_BUSY · TOKEN_KEY_UNAVAILABLE · TOKEN_RETIRED ·
     * PUSH_BLOCKED_TOKEN_CONFLICT. [actorBusy] is read under [LOCK], which is
     * the lock the actor updates its queue under, so a ticket is captured only
     * while the actor is idle.
     */
    fun captureTicket(
        context: Context,
        generation: Long,
        token: String,
        continuityDecided: Boolean,
        actorBusy: () -> Boolean,
    ): Capture = synchronized(LOCK) {
        val store = prefs(context)
        val state = read(context)
        if (state.resetPending != null) return Capture.Deferred("RESET_PENDING")
        if (!continuityDecided) return Capture.Deferred("CONTINUITY_PENDING")
        if (state.rotationPending) return Capture.Deferred("TOKEN_ROTATION_PENDING")
        if (actorBusy()) return Capture.Deferred("TOKEN_ACTOR_BUSY")
        if (state.installKeyRecoveryPending) return Capture.Deferred("TOKEN_KEY_UNAVAILABLE")
        val hash = installHashLocked(store, null, token) ?: return Capture.Deferred("TOKEN_KEY_UNAVAILABLE")
        if (isRetiredLocked(store, hash)) return Capture.Deferred("TOKEN_RETIRED")
        if (state.conflictBlockedGeneration != NO_GENERATION && state.conflictBlockedGeneration == generation) {
            return Capture.Deferred("PUSH_BLOCKED_TOKEN_CONFLICT")
        }
        if (!state.isCurrent(generation, token)) return Capture.Superseded
        val seq = store.getLong(KEY_TICKET_SEQ, 0L) + 1
        store.edit().putLong(KEY_TICKET_SEQ, seq).commit()
        Capture.Captured(Ticket(state.resetEpoch, generation, token, seq))
    }

    private fun ticketCurrentLocked(context: Context, ticket: Ticket): Boolean {
        val store = prefs(context)
        val state = read(context)
        return state.resetPending == null &&
            state.resetEpoch == ticket.resetEpoch &&
            state.sessionGeneration == ticket.generation &&
            state.newestToken == ticket.token &&
            ticket.seq > store.getLong(KEY_APPLIED_TICKET_SEQ, 0L)
    }

    /** Whether a ticket's result could still change anything. */
    fun isTicketCurrent(context: Context, ticket: Ticket): Boolean = synchronized(LOCK) { ticketCurrentLocked(context, ticket) }

    /**
     * A 200 for a current ticket: registered, block cleared, display allowed.
     * A non-current ticket changes nothing at all.
     */
    fun applyRegisteredIfCurrent(context: Context, ticket: Ticket): Boolean = synchronized(LOCK) {
        if (!ticketCurrentLocked(context, ticket)) return false
        prefs(context).edit()
            .putString(KEY_REGISTERED_TOKEN, ticket.token)
            .putLong(KEY_REGISTERED_GENERATION, ticket.generation)
            .putLong(KEY_REGISTERED_TICKET_SEQ, ticket.seq)
            .putLong(KEY_REGISTERED_EPOCH, ticket.resetEpoch)
            .putLong(KEY_APPLIED_TICKET_SEQ, ticket.seq)
            .remove(KEY_BLOCKED_REASON)
            .remove(KEY_BLOCKED_GENERATION)
            .remove(KEY_BLOCKED_TOKEN)
            .putBoolean(KEY_DISPLAY_ALLOWED, true)
            .commit()
        true
    }

    /** A terminal refusal for a current ticket. */
    fun applyBlockIfCurrent(context: Context, ticket: Ticket, reason: String): Boolean = synchronized(LOCK) {
        if (!ticketCurrentLocked(context, ticket)) return false
        prefs(context).edit()
            .putString(KEY_BLOCKED_REASON, reason)
            .putLong(KEY_BLOCKED_GENERATION, ticket.generation)
            .putString(KEY_BLOCKED_TOKEN, ticket.token)
            .putLong(KEY_APPLIED_TICKET_SEQ, ticket.seq)
            .commit()
        true
    }

    /**
     * `409 PUSH_TOKEN_BOUND_TO_OTHER_DEVICE` for a ticket (§5.7.4 step 0).
     *
     * Stale ⇒ nothing. First conflict in the generation ⇒ RECOVER: the caller
     * enqueues RETIRE_AND_ROTATE with this ticket, and the job itself retires
     * and counts the recovery only if the ticket is still current when it
     * starts (D-1). Second ⇒ BLOCKED_TOKEN_CONFLICT for the generation.
     */
    fun applyConflictIfCurrent(context: Context, ticket: Ticket): ConflictResult = synchronized(LOCK) {
        if (!ticketCurrentLocked(context, ticket)) return ConflictResult.STALE
        val store = prefs(context)
        if (store.getLong(KEY_RECOVERY_GENERATION, NO_GENERATION) == ticket.generation) {
            store.edit()
                .putString(KEY_BLOCKED_REASON, TOKEN_SCOPED_REASON)
                .putLong(KEY_BLOCKED_GENERATION, ticket.generation)
                .putString(KEY_BLOCKED_TOKEN, ticket.token)
                .putLong(KEY_CONFLICT_GENERATION, ticket.generation)
                .putLong(KEY_APPLIED_TICKET_SEQ, ticket.seq)
                .commit()
            return ConflictResult.BLOCKED
        }
        store.edit().putLong(KEY_APPLIED_TICKET_SEQ, ticket.seq).commit()
        ConflictResult.RECOVER
    }

    /**
     * Start of a RETIRE_AND_ROTATE job (§5.7.2 item 3, Identity D-1).
     *
     * Re-validates the 409 ticket under the lock: if a newer ticket was applied,
     * the token or generation moved, or a reset happened, the job ends here
     * without a provider call, without retiring anything and without touching
     * the recovery count. Otherwise the ticket's token is retired, the recovery
     * is counted for the generation and rotation becomes pending, in one commit.
     */
    fun beginConflictRecoveryIfCurrent(context: Context, ticket: Ticket, wallMs: Long = System.currentTimeMillis()): Boolean =
        synchronized(LOCK) {
            val store = prefs(context)
            val state = read(context)
            val current = state.resetPending == null &&
                state.resetEpoch == ticket.resetEpoch &&
                state.sessionGeneration == ticket.generation &&
                state.newestToken == ticket.token &&
                store.getLong(KEY_APPLIED_TICKET_SEQ, 0L) == ticket.seq &&
                store.getLong(KEY_RECOVERY_GENERATION, NO_GENERATION) != ticket.generation
            if (!current) return false
            val editor = store.edit()
            val hash = installHashLocked(store, editor, ticket.token)
            if (hash == null) {
                editor.putBoolean(KEY_RECOVER_KEY_PENDING, true)
            } else {
                editor.putString(KEY_RETIRED_HASHES, retiredWith(store, listOf(hash)))
            }
            editor.putLong(KEY_RECOVERY_GENERATION, ticket.generation)
            markRotationPending(store, editor, wallMs)
            editor.commit()
            true
        }

    /**
     * Pre-ticket application, kept for state fixtures. Applies only for the
     * current pair and never while a reset is pending; it does not allow display.
     */
    @VisibleForTesting
    fun applyRegisteredIfCurrent(context: Context, generation: Long, token: String): Boolean =
        synchronized(LOCK) {
            val state = read(context)
            if (state.resetPending != null || !state.isCurrent(generation, token)) return false
            prefs(context).edit()
                .putString(KEY_REGISTERED_TOKEN, token)
                .putLong(KEY_REGISTERED_GENERATION, generation)
                .remove(KEY_BLOCKED_REASON)
                .remove(KEY_BLOCKED_GENERATION)
                .remove(KEY_BLOCKED_TOKEN)
                .commit()
            true
        }

    /** Pre-ticket block application, kept for state fixtures. */
    @VisibleForTesting
    fun applyBlockIfCurrent(context: Context, generation: Long, token: String, reason: String): Boolean =
        synchronized(LOCK) {
            val state = read(context)
            if (state.resetPending != null || !state.isCurrent(generation, token)) return false
            prefs(context).edit()
                .putString(KEY_BLOCKED_REASON, reason)
                .putLong(KEY_BLOCKED_GENERATION, generation)
                .putString(KEY_BLOCKED_TOKEN, token)
                .commit()
            true
        }

    // ── token commits by the actor (§5.7.2 item 6) ─────────────────────────

    /**
     * Compare-and-set of a token read from the provider at the end of a job.
     *
     * Applied only if: no reset pending; the job's reset epoch is current; the
     * retired set is verifiable and the token's hash is not in it; while a
     * K_install recovery is pending, only a RECOVER_KEY job whose delete
     * completed may commit. Effect, in one commit: newest token, and the
     * rotation (and recovery) flags cleared.
     */
    fun commitToken(
        context: Context,
        jobEpoch: Long,
        kind: CommitKind,
        token: String,
        deleteSucceeded: Boolean,
    ): CommitResult = synchronized(LOCK) {
        val store = prefs(context)
        val state = read(context)
        if (state.resetPending != null) return CommitResult.Rejected("reset-pending")
        if (state.resetEpoch != jobEpoch) return CommitResult.Rejected("epoch")
        if (state.installKeyRecoveryPending && !(kind == CommitKind.RECOVER_KEY && deleteSucceeded)) {
            return CommitResult.Rejected("key-recovery-pending")
        }
        val hash = installHashLocked(store, null, token) ?: return CommitResult.Rejected("key-unavailable")
        val retired = isRetiredLocked(store, hash)
        // Item 6 also allows a ROTATE-family commit when its delete completed;
        // a retired hash is refused either way, which implies that condition.
        if (retired) return CommitResult.Rejected("retired")
        val changed = state.newestToken != token
        val editor = store.edit().putString(KEY_NEWEST_TOKEN, token)
        if (state.rotationPending) {
            editor.remove(KEY_ROTATION_PENDING).remove(KEY_ROTATION_PENDING_SINCE).remove(KEY_ROTATION_NOTICE_SHOWN)
        }
        if (kind == CommitKind.RECOVER_KEY) editor.remove(KEY_RECOVER_KEY_PENDING)
        editor.commit()
        CommitResult.Committed(changed, read(context))
    }

    fun rotationPending(context: Context): Boolean = synchronized(LOCK) { prefs(context).getBoolean(KEY_ROTATION_PENDING, false) }

    fun resetEpoch(context: Context): Long = synchronized(LOCK) { prefs(context).getLong(KEY_RESET_EPOCH, 0L) }

    fun markDeleteConfirmed(context: Context, wallMs: Long = System.currentTimeMillis()) = synchronized(LOCK) {
        prefs(context).edit().putLong(KEY_DELETE_CONFIRMED_AT, wallMs).commit()
    }

    /** Whether the retired set can be checked now (C-1). Creates K_install on first use. */
    fun installKeyAvailable(context: Context): Boolean = synchronized(LOCK) {
        val store = prefs(context)
        !store.getBoolean(KEY_RECOVER_KEY_PENDING, false) && installHashLocked(store, null, "probe") != null
    }

    /** Whether the stored key id points at a usable key, without creating one. */
    fun installKeyBroken(context: Context): Boolean = synchronized(LOCK) {
        val store = prefs(context)
        val id = store.getString(KEY_RETIRED_SET_KEY_ID, null) ?: return false
        !runCatching { ShellKeys.backend.exists(id) && ShellKeys.backend.hmac(id, ByteArray(1)).isNotEmpty() }.getOrDefault(false)
    }

    /**
     * Start of a RECOVER_KEY job (§5.7.1a): fresh K_install under a new alias
     * generation, the unverifiable retired set discarded, rotation pending and
     * a token accepted only after a confirmed deletion in this same job.
     */
    fun beginInstallKeyRecovery(context: Context, wallMs: Long = System.currentTimeMillis()): Boolean = synchronized(LOCK) {
        val store = prefs(context)
        if (store.getString(KEY_RESET_PENDING, null) != null) return false
        val alias = nextInstallAlias(store)
        val created = runCatching {
            runCatching { ShellKeys.backend.delete(alias) }
            ShellKeys.backend.create(alias)
            ShellKeys.backend.hmac(alias, ByteArray(1)).isNotEmpty()
        }.getOrDefault(false)
        val editor = store.edit()
            .remove(KEY_RETIRED_HASHES)
            .putBoolean(KEY_RECOVER_KEY_PENDING, true)
        markRotationPending(store, editor, wallMs)
        if (created) editor.putString(KEY_RETIRED_SET_KEY_ID, alias)
        editor.commit()
        created
    }

    // ── reset step 0 and completion (§5.3, §5.3a) ──────────────────────────

    /**
     * Reset step 0: the durable intent, in one synchronous commit, under [LOCK].
     *
     * `reset_pending`, display off, rotation pending, the keyed hashes of both
     * the newest and the registered token retired, the binding and blocks
     * cleared, the continuity record deleted and `reset_epoch` incremented.
     * Returns the new epoch.
     */
    fun beginReset(context: Context, reason: String, wallMs: Long, elapsedMs: Long): Long = synchronized(LOCK) {
        val store = prefs(context)
        val state = read(context)
        val editor = store.edit()
        val tokens = listOfNotNull(state.newestToken, state.registeredToken).distinct()
        val hashes = tokens.map { installHashLocked(store, editor, it) }
        if (hashes.any { it == null }) editor.putBoolean(KEY_RECOVER_KEY_PENDING, true)
        val known = hashes.filterNotNull()
        if (known.isNotEmpty()) editor.putString(KEY_RETIRED_HASHES, retiredWith(store, known))
        val epoch = state.resetEpoch + 1
        editor
            .putString(KEY_RESET_PENDING, reason)
            .putBoolean(KEY_DISPLAY_ALLOWED, false)
            .putBoolean(KEY_ROTATION_PENDING, true)
            .putLong(KEY_ROTATION_PENDING_SINCE, wallMs)
            .remove(KEY_ROTATION_NOTICE_SHOWN)
            .remove(KEY_NEWEST_TOKEN)
            .remove(KEY_REGISTERED_TOKEN)
            .remove(KEY_REGISTERED_GENERATION)
            .remove(KEY_REGISTERED_TICKET_SEQ)
            .remove(KEY_REGISTERED_EPOCH)
            .remove(KEY_BLOCKED_REASON)
            .remove(KEY_BLOCKED_GENERATION)
            .remove(KEY_BLOCKED_TOKEN)
            .remove(KEY_CONFLICT_GENERATION)
            .remove(KEY_RECOVERY_GENERATION)
            .remove(KEY_CTX_BODY)
            .remove(KEY_CTX_MAC)
            .putLong(KEY_RESET_EPOCH, epoch)
            .putLong(KEY_LAST_RESET_WALL, wallMs)
            .putLong(KEY_LAST_RESET_ELAPSED, elapsedMs)
            .putString(KEY_LAST_RESET_REASON, reason)
            .commit()
        epoch
    }

    fun resetPending(context: Context): String? = synchronized(LOCK) { prefs(context).getString(KEY_RESET_PENDING, null) }

    /** §5.3a: committed only after the cookie removal was verified in this process. */
    fun completeReset(context: Context) = synchronized(LOCK) {
        prefs(context).edit().remove(KEY_RESET_PENDING).commit()
    }

    fun lastReset(context: Context): LastReset? = synchronized(LOCK) {
        val store = prefs(context)
        val reason = store.getString(KEY_LAST_RESET_REASON, null) ?: return null
        LastReset(store.getLong(KEY_LAST_RESET_WALL, 0L), store.getLong(KEY_LAST_RESET_ELAPSED, 0L), reason)
    }

    fun displayAllowed(context: Context): Boolean = synchronized(LOCK) { prefs(context).getBoolean(KEY_DISPLAY_ALLOWED, true) }

    /** Shortcut-initiated OPERATOR_SWITCH: at most 3 per 10 minutes (§5.4, §5.5). */
    fun admitShortcutReset(context: Context, wallMs: Long): Boolean = synchronized(LOCK) {
        val store = prefs(context)
        val recent = store.getString(KEY_SHORTCUT_RESETS, null).orEmpty()
            .split(',').mapNotNull { it.toLongOrNull() }
            .filter { wallMs - it in 0 until SHORTCUT_WINDOW_MS }
        if (recent.size >= SHORTCUT_LIMIT) return false
        store.edit().putString(KEY_SHORTCUT_RESETS, (recent + wallMs).joinToString(",")).commit()
        true
    }

    /** O-3: once, when rotation has been pending for more than 24 h. */
    fun takeRotationNotice(context: Context, wallMs: Long): Boolean = synchronized(LOCK) {
        val store = prefs(context)
        if (!store.getBoolean(KEY_ROTATION_PENDING, false)) return false
        if (store.getString(KEY_RESET_PENDING, null) != null) return false
        val since = store.getLong(KEY_ROTATION_PENDING_SINCE, 0L)
        if (since <= 0L || wallMs - since <= ROTATION_NOTICE_AFTER_MS) return false
        if (store.getBoolean(KEY_ROTATION_NOTICE_SHOWN, false)) return false
        store.edit().putBoolean(KEY_ROTATION_NOTICE_SHOWN, true).commit()
        true
    }

    /** §5.7.4 step 2: one notice per conflict-blocked generation. */
    fun takeConflictNotice(context: Context): Boolean = synchronized(LOCK) {
        val store = prefs(context)
        val generation = store.getLong(KEY_CONFLICT_GENERATION, NO_GENERATION)
        if (generation == NO_GENERATION || generation != store.getLong(KEY_SESSION_GENERATION, NO_GENERATION)) return false
        if (store.getLong(KEY_CONFLICT_NOTICE_GENERATION, NO_GENERATION) == generation) return false
        store.edit().putLong(KEY_CONFLICT_NOTICE_GENERATION, generation).commit()
        true
    }

    // ── edge gate (IMPL-1 tri-state) ───────────────────────────────────────

    fun edgeGate(context: Context): ContinuityGuard.EdgeGate = synchronized(LOCK) {
        when (prefs(context).getString(KEY_EDGE_GATE, null)) {
            "PRESENT" -> ContinuityGuard.EdgeGate.PRESENT
            "ABSENT" -> ContinuityGuard.EdgeGate.ABSENT
            else -> ContinuityGuard.EdgeGate.UNKNOWN
        }
    }

    fun setEdgeGate(context: Context, gate: ContinuityGuard.EdgeGate) = synchronized(LOCK) {
        val editor = prefs(context).edit()
        when (gate) {
            ContinuityGuard.EdgeGate.UNKNOWN -> editor.remove(KEY_EDGE_GATE)
            else -> editor.putString(KEY_EDGE_GATE, gate.name)
        }
        editor.commit()
    }

    // ── continuity record storage (§5.8.2) ─────────────────────────────────

    fun continuityRecord(context: Context): StoredRecord = synchronized(LOCK) { continuityRecordLocked(context) }

    internal fun continuityRecordLocked(context: Context): StoredRecord {
        val store = prefs(context)
        return StoredRecord(
            body = store.getString(KEY_CTX_BODY, null),
            mac = store.getString(KEY_CTX_MAC, null),
            keyAlias = store.getString(KEY_CTX_KEY_ID, null),
            resetEpoch = store.getLong(KEY_RESET_EPOCH, 0L),
            generation = store.getLong(KEY_SESSION_GENERATION, NO_GENERATION),
        )
    }

    internal fun nextContextKeyAliasLocked(context: Context): String {
        val current = prefs(context).getString(KEY_CTX_KEY_ID, null)
        val generation = current?.removePrefix(ShellKeys.CONTEXT_ALIAS_PREFIX)?.toLongOrNull() ?: 0L
        return ShellKeys.CONTEXT_ALIAS_PREFIX + (generation + 1)
    }

    internal fun storeContinuityRecordLocked(context: Context, alias: String, body: String, mac: String) {
        prefs(context).edit()
            .putString(KEY_CTX_KEY_ID, alias)
            .putString(KEY_CTX_BODY, body)
            .putString(KEY_CTX_MAC, mac)
            .commit()
    }

    // ── K_install and the retired set (§5.7.1, §5.7.1a) ────────────────────

    /**
     * The keyed hash of [token], or null when the retired set cannot be checked.
     *
     * The first use on an installation creates K_install and records its alias;
     * the id goes into [editor] when one is given so that step 0 stays a single
     * commit. A recorded alias that is missing or failing is "unavailable".
     */
    private fun installHashLocked(store: SharedPreferences, editor: SharedPreferences.Editor?, token: String): String? {
        var alias = store.getString(KEY_RETIRED_SET_KEY_ID, null)
        if (alias == null) {
            val fresh = ShellKeys.INSTALL_ALIAS_PREFIX + "1"
            val created = runCatching {
                if (!ShellKeys.backend.exists(fresh)) ShellKeys.backend.create(fresh)
                true
            }.getOrDefault(false)
            if (!created) return null
            if (editor != null) editor.putString(KEY_RETIRED_SET_KEY_ID, fresh) else store.edit().putString(KEY_RETIRED_SET_KEY_ID, fresh).commit()
            alias = fresh
        }
        val key: String = alias
        return runCatching {
            val payload = RETIRED_PREFIX.toByteArray(Charsets.US_ASCII) + byteArrayOf(0) + token.toByteArray(Charsets.UTF_8)
            ShellKeys.hmacHex(key, payload)
        }.getOrNull()
    }

    private fun isRetiredLocked(store: SharedPreferences, hash: String): Boolean {
        val candidate = hash.toByteArray(Charsets.US_ASCII)
        var found = false
        for (entry in retiredList(store)) {
            if (MessageDigest.isEqual(entry.toByteArray(Charsets.US_ASCII), candidate)) found = true
        }
        return found
    }

    private fun retiredList(store: SharedPreferences): List<String> =
        store.getString(KEY_RETIRED_HASHES, null).orEmpty().split(',').filter { it.isNotEmpty() }

    private fun retiredWith(store: SharedPreferences, added: List<String>): String =
        (retiredList(store) + added).takeLast(RETIRED_CAPACITY).joinToString(",")

    private fun nextInstallAlias(store: SharedPreferences): String {
        val current = store.getString(KEY_RETIRED_SET_KEY_ID, null)
        val generation = current?.removePrefix(ShellKeys.INSTALL_ALIAS_PREFIX)?.toLongOrNull() ?: 0L
        return ShellKeys.INSTALL_ALIAS_PREFIX + (generation + 1)
    }

    private fun markRotationPending(store: SharedPreferences, editor: SharedPreferences.Editor, wallMs: Long) {
        if (!store.getBoolean(KEY_ROTATION_PENDING, false)) {
            editor.putBoolean(KEY_ROTATION_PENDING, true).putLong(KEY_ROTATION_PENDING_SINCE, wallMs)
        }
    }

    /** For tests that need to look at the retired set without a key. */
    @VisibleForTesting
    fun retiredCount(context: Context): Int = synchronized(LOCK) { retiredList(prefs(context)).size }

    @VisibleForTesting
    fun isRetired(context: Context, token: String): Boolean = synchronized(LOCK) {
        val store = prefs(context)
        val hash = installHashLocked(store, null, token) ?: return true
        isRetiredLocked(store, hash)
    }
}
