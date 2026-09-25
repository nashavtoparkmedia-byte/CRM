package ru.yokoone.crm.shell.push

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/**
 * The races a queue policy cannot win on its own.
 *
 * ExistingWorkPolicy.REPLACE cancels what is queued; it cannot recall a request
 * already on the wire. So every one of these drives a reply that belongs to an
 * attempt something newer has already superseded, and asserts that it changes
 * nothing. The failure mode being prevented is concrete: a late 409 for a token
 * the device no longer holds would otherwise record a block against the token
 * it does hold, and the operator would simply stop receiving push.
 */
@RunWith(RobolectricTestRunner::class)
class PushRegistrationWorkTest {

    private val context: Context get() = ApplicationProvider.getApplicationContext()

    @Before
    fun clearState() {
        context.getSharedPreferences(PushTokenState.PREFS_NAME, Context.MODE_PRIVATE)
            .edit().clear().commit()
    }

    private fun state() = PushTokenState.snapshot(context)

    /** T1 known and an authenticated session in place. */
    private fun startedAttempt(): Long {
        PushTokenState.rememberToken(context, "T1")
        return PushTokenState.startSessionGeneration(context).sessionGeneration
    }

    /** Runs one attempt whose reply arrives after [duringRequest] has happened. */
    private fun runWithRace(
        generation: Long,
        token: String = "T1",
        attempt: Int = 0,
        duringRequest: () -> Unit = {},
        reply: PushRegistrar.Outcome,
    ): PushRegistrationWork.Outcome =
        PushRegistrationWork.run(context, generation, token, attempt) {
            duringRequest()
            reply
        }

    @Test
    fun `an uncontested success records the token and the generation together`() {
        val generation = startedAttempt()

        val outcome = runWithRace(generation, reply = PushRegistrar.Outcome.Registered)

        assertEquals(PushRegistrationWork.Outcome.SUCCESS, outcome)
        val state = state()
        assertEquals("T1", state.registeredToken)
        assertEquals(generation, state.registeredGeneration)
        assertTrue(state.isRegistered)
    }

    @Test
    fun `a success for a token that has since been replaced changes nothing`() {
        val generation = startedAttempt()

        val outcome = runWithRace(
            generation,
            duringRequest = { PushTokenState.rememberToken(context, "T2") },
            reply = PushRegistrar.Outcome.Registered,
        )

        assertEquals(PushRegistrationWork.Outcome.SUCCESS, outcome)
        val state = state()
        assertNull("the superseded token must not be recorded as registered", state.registeredToken)
        assertEquals("T2", state.newestToken)
        assertTrue("the new token still needs registering", state.needsRegistration)
    }

    @Test
    fun `a refusal for a token that has since been replaced writes no block`() {
        for (code in listOf(
            "MOBILE_SESSION_REVOKED",
            "PUSH_TOKEN_BOUND_TO_OTHER_DEVICE",
            "PUSH_DEVICE_ID_NOT_STABLE",
        )) {
            clearState()
            val generation = startedAttempt()

            val outcome = runWithRace(
                generation,
                duringRequest = { PushTokenState.rememberToken(context, "T2") },
                reply = PushRegistrar.Outcome.Refused(code),
            )

            assertEquals("$code should end quietly", PushRegistrationWork.Outcome.SUCCESS, outcome)
            val state = state()
            assertNull("$code must not be recorded against T2", state.blockedReason)
            assertTrue("$code must leave T2 free to register", state.needsRegistration)
        }
    }

    @Test
    fun `a success from a superseded session does not advance the generation`() {
        val generation = startedAttempt()

        val outcome = runWithRace(
            generation,
            duringRequest = { PushTokenState.startSessionGeneration(context) },
            reply = PushRegistrar.Outcome.Registered,
        )

        assertEquals(PushRegistrationWork.Outcome.SUCCESS, outcome)
        val state = state()
        assertNull(state.registeredToken)
        assertFalse(state.isRegistered)
        assertTrue("the new session must still register", state.needsRegistration)
    }

    @Test
    fun `a refusal from a superseded session does not block the new one`() {
        val generation = startedAttempt()

        val outcome = runWithRace(
            generation,
            duringRequest = { PushTokenState.startSessionGeneration(context) },
            reply = PushRegistrar.Outcome.Refused("MOBILE_SESSION_REQUIRED"),
        )

        assertEquals(PushRegistrationWork.Outcome.SUCCESS, outcome)
        val state = state()
        assertFalse(state.isBlocked)
        assertTrue(state.needsRegistration)
    }

    @Test
    fun `an attempt that is already stale spends no network at all`() {
        val generation = startedAttempt()
        PushTokenState.rememberToken(context, "T2")
        var called = false

        val outcome = PushRegistrationWork.run(context, generation, "T1", 0) {
            called = true
            PushRegistrar.Outcome.Registered
        }

        assertEquals(PushRegistrationWork.Outcome.SUCCESS, outcome)
        assertFalse("a superseded attempt must not reach the network", called)
    }

    @Test
    fun `an uncontested refusal is recorded and ends the work`() {
        val generation = startedAttempt()

        val outcome = runWithRace(generation, reply = PushRegistrar.Outcome.Refused("MOBILE_SESSION_REVOKED"))

        assertEquals(PushRegistrationWork.Outcome.FAILURE, outcome)
        val state = state()
        assertEquals("MOBILE_SESSION_REVOKED", state.blockedReason)
        assertTrue(state.isBlocked)
        assertFalse(state.needsRegistration)
    }

    @Test
    fun `a transient failure retries, and does not touch durable state`() {
        val generation = startedAttempt()

        val outcome = runWithRace(generation, reply = PushRegistrar.Outcome.Retryable("http_503"))

        assertEquals(PushRegistrationWork.Outcome.RETRY, outcome)
        val state = state()
        assertNull(state.blockedReason)
        assertNull(state.registeredToken)
        assertTrue(state.needsRegistration)
    }

    @Test
    fun `a transient failure for a superseded attempt is not retried`() {
        val generation = startedAttempt()

        val outcome = runWithRace(
            generation,
            duringRequest = { PushTokenState.rememberToken(context, "T2") },
            reply = PushRegistrar.Outcome.Retryable("timeout"),
        )

        assertEquals(PushRegistrationWork.Outcome.SUCCESS, outcome)
    }

    @Test
    fun `attempts are bounded and the cap is checked before the network`() {
        val generation = startedAttempt()
        var called = false

        val outcome = PushRegistrationWork.run(
            context,
            generation,
            "T1",
            PushRegistrationWork.MAX_ATTEMPTS,
        ) {
            called = true
            PushRegistrar.Outcome.Registered
        }

        assertEquals(PushRegistrationWork.Outcome.FAILURE, outcome)
        assertFalse(called)
    }

    @Test
    fun `work without a token or a session is refused rather than run`() {
        assertEquals(
            PushRegistrationWork.Outcome.FAILURE,
            PushRegistrationWork.run(context, 1L, "", 0) { PushRegistrar.Outcome.Registered },
        )
        assertEquals(
            PushRegistrationWork.Outcome.FAILURE,
            PushRegistrationWork.run(context, PushTokenState.NO_GENERATION, "T1", 0) {
                PushRegistrar.Outcome.Registered
            },
        )
    }
}
