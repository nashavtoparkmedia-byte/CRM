package ru.yokoone.crm.shell.push

import android.content.Context

/**
 * One registration attempt, expressed without WorkManager so it can be proved.
 *
 * The worker that runs this is a shell around it. Everything that decides
 * whether the device ends up registered — the attempt cap, the two currency
 * checks and which durable field may be written — lives here, where a unit test
 * can drive it and interleave a competing token or a newer session at the exact
 * moment a race would.
 *
 * The invariant this exists to enforce: the newest (token, generation) pair owns
 * the durable state. ExistingWorkPolicy.REPLACE cancels a queued attempt but
 * cannot un-send a request that is already in flight, so a reply belonging to a
 * superseded attempt can and will arrive. It must change nothing — not the
 * registered token, not the generation, not a block, not anything. Otherwise a
 * late 409 for a token nobody holds any more would suppress registration of the
 * token the device actually has.
 */
object PushRegistrationWork {

    /** Five network attempts per enqueue, then the work ends rather than looping. */
    const val MAX_ATTEMPTS = 5

    enum class Outcome { SUCCESS, FAILURE, RETRY }

    fun run(
        context: Context,
        generation: Long,
        token: String,
        attempt: Int,
        register: (String) -> PushRegistrar.Outcome,
    ): Outcome {
        if (token.isEmpty() || generation == PushTokenState.NO_GENERATION) return Outcome.FAILURE
        if (attempt >= MAX_ATTEMPTS) return Outcome.FAILURE

        // Before the request: if this attempt is already superseded, spend no
        // network at all and touch nothing.
        if (!PushTokenState.snapshot(context).isCurrent(generation, token)) return Outcome.SUCCESS

        val result = register(token)

        // After the request: the state may have moved while we waited. The
        // apply calls re-check under the same lock they write in, so the
        // decision below cannot be undone by a write that lands between the
        // check and the commit.
        return when (result) {
            is PushRegistrar.Outcome.Registered -> {
                PushTokenState.applyRegisteredIfCurrent(context, generation, token)
                Outcome.SUCCESS
            }

            is PushRegistrar.Outcome.Refused -> {
                val applied = PushTokenState.applyBlockIfCurrent(context, generation, token, result.code)
                // A refusal that no longer applies to anything is not a failure
                // worth recording; the newer attempt owns the outcome.
                if (applied) Outcome.FAILURE else Outcome.SUCCESS
            }

            is PushRegistrar.Outcome.Retryable -> {
                if (PushTokenState.snapshot(context).isCurrent(generation, token)) {
                    Outcome.RETRY
                } else {
                    Outcome.SUCCESS
                }
            }
        }
    }
}
