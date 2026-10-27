package ru.yokoone.crm.shell.push

import android.content.Context
import ru.yokoone.crm.shell.ContinuityGuard
import ru.yokoone.crm.shell.ShellDiagnostics

/**
 * One registration attempt, expressed without WorkManager so it can be proved.
 *
 * The worker that runs this is a shell around it. Everything that decides
 * whether the device ends up registered — the attempt cap, the gates, the
 * registration ticket and which durable field may be written — lives here,
 * where a unit test can drive it and interleave a competing token, a newer
 * session or a reset at the exact moment a race would.
 *
 * The invariant this exists to enforce: the newest (token, generation) pair owns
 * the durable state. ExistingWorkPolicy.REPLACE cancels a queued attempt but
 * cannot un-send a request that is already in flight, so a reply belonging to a
 * superseded attempt can and will arrive. It must change nothing — not the
 * registered token, not the generation, not a block, not anything. Otherwise a
 * late 409 for a token nobody holds any more would suppress registration of the
 * token the device actually has.
 *
 * Edge design R5.1 (§5.7.3, §5.7.3a, §5.7.4) makes that rule a ticket: it is
 * captured under [PushTokenState.LOCK] immediately before the request, only when
 * every gate passes and the token actor is idle, and a result changes local
 * state only while that ticket is still current. A 409 for a current ticket
 * starts the bounded recovery instead of a silent block.
 */
object PushRegistrationWork {

    /** Five network attempts per enqueue, then the work ends rather than looping. */
    const val MAX_ATTEMPTS = 5

    enum class Outcome { SUCCESS, FAILURE, RETRY, DEFERRED }

    fun run(
        context: Context,
        generation: Long,
        token: String,
        attempt: Int,
        register: (String) -> PushRegistrar.Outcome,
    ): Outcome {
        if (token.isEmpty() || generation == PushTokenState.NO_GENERATION) return Outcome.FAILURE
        if (attempt >= MAX_ATTEMPTS) return Outcome.FAILURE

        // Gates and ticket, before any network I/O. A superseded attempt spends
        // no network and touches nothing; a gated one defers without a block.
        val capture = PushTokenState.captureTicket(
            context,
            generation,
            token,
            continuityDecided = ContinuityGuard.allowsRegistration,
            actorBusy = { TokenActor.busyForRegistrationLocked() },
        )
        val ticket = when (capture) {
            is PushTokenState.Capture.Superseded -> return Outcome.SUCCESS
            is PushTokenState.Capture.Deferred -> {
                ShellDiagnostics.write("YOKO_NET fail push-registration deferred ${capture.reason}")
                return Outcome.DEFERRED
            }
            is PushTokenState.Capture.Captured -> capture.ticket
        }

        val result = register(token)

        // After the request: the state may have moved while we waited. Every
        // apply re-checks the ticket under the same lock it writes in.
        return when (result) {
            is PushRegistrar.Outcome.Registered -> {
                PushTokenState.applyRegisteredIfCurrent(context, ticket)
                Outcome.SUCCESS
            }

            is PushRegistrar.Outcome.Refused -> {
                if (result.code == PushTokenState.TOKEN_SCOPED_REASON) {
                    when (PushTokenState.applyConflictIfCurrent(context, ticket)) {
                        PushTokenState.ConflictResult.STALE -> Outcome.SUCCESS
                        PushTokenState.ConflictResult.RECOVER -> {
                            ShellDiagnostics.write("YOKO_NET fail push-registration conflict recovery")
                            TokenActor.enqueueRetireAndRotate(context, ticket)
                            Outcome.SUCCESS
                        }
                        PushTokenState.ConflictResult.BLOCKED -> {
                            ShellDiagnostics.write("YOKO_NET fail push-blocked token-conflict")
                            Outcome.FAILURE
                        }
                    }
                } else {
                    val applied = PushTokenState.applyBlockIfCurrent(context, ticket, result.code)
                    // A refusal that no longer applies to anything is not a failure
                    // worth recording; the newer attempt owns the outcome.
                    if (applied) Outcome.FAILURE else Outcome.SUCCESS
                }
            }

            is PushRegistrar.Outcome.Retryable -> {
                if (PushTokenState.isTicketCurrent(context, ticket)) Outcome.RETRY else Outcome.SUCCESS
            }

            // Nothing decided, nothing written; an event re-drives it.
            is PushRegistrar.Outcome.Deferred -> Outcome.DEFERRED
        }
    }
}
