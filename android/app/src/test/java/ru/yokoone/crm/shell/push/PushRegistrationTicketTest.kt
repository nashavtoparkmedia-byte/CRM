package ru.yokoone.crm.shell.push

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import ru.yokoone.crm.shell.ContinuityGuard
import ru.yokoone.crm.shell.EdgeContextReset
import ru.yokoone.crm.shell.EdgeTestSupport

/**
 * Registration gates, tickets and the bounded 409 recovery (R5.1 §4.1 item 8,
 * §5.7.3, §5.7.3a, §5.7.4): T8, T35, T38c, T59, T60, T65, T80, T101, T102,
 * T108–T111.
 */
@RunWith(RobolectricTestRunner::class)
class PushRegistrationTicketTest {

    private val context: Context get() = ApplicationProvider.getApplicationContext()
    private lateinit var provider: EdgeTestSupport.FakeProvider
    private val realScheduler = PushRegistration.scheduler

    @Before
    fun setUp() {
        EdgeTestSupport.reset(context)
        provider = EdgeTestSupport.FakeProvider()
        EdgeTestSupport.useProvider(provider)
        PushRegistration.scheduler = PushRegistration.Scheduler { _, _, _ -> }
    }

    @After
    fun tearDown() {
        provider.releaseAll()
        EdgeTestSupport.idle()
        EdgeTestSupport.useProvider(null)
        PushRegistration.scheduler = realScheduler
    }

    private fun state() = PushTokenState.snapshot(context)

    /** T1 committed by the actor and an authenticated session generation. */
    private fun started(token: String = "T1"): Long {
        provider.current = token
        PushRegistration.onNewToken(context, token)
        EdgeTestSupport.idle()
        assertEquals(token, state().newestToken)
        return PushTokenState.startSessionGeneration(context).sessionGeneration
    }

    private fun capture(generation: Long, token: String): PushTokenState.Ticket =
        (PushTokenState.captureTicket(context, generation, token, true) { false } as PushTokenState.Capture.Captured).ticket

    private fun reset() {
        PushTokenState.beginReset(context, EdgeContextReset.Reason.OPERATOR_SWITCH, System.currentTimeMillis(), 0L)
    }

    @Test
    fun `T8 a deferred answer writes nothing and asks for no retry`() {
        val generation = started()
        val before = state()
        val outcome = PushRegistrationWork.run(context, generation, "T1", 0) { PushRegistrar.Outcome.Deferred("EDGE_CREDENTIAL_ABSENT") }
        assertEquals(PushRegistrationWork.Outcome.DEFERRED, outcome)
        assertEquals(before, state())
    }

    @Test
    fun `T38c T80 the gates refuse in order, before any request`() {
        val generation = started()
        var requests = 0
        val register: (String) -> PushRegistrar.Outcome = { requests++; PushRegistrar.Outcome.Registered }

        ContinuityGuard.state = ContinuityGuard.State.PENDING
        assertEquals(PushTokenState.Capture.Deferred("CONTINUITY_PENDING"), PushTokenState.captureTicket(context, generation, "T1", false) { false })
        assertEquals(PushRegistrationWork.Outcome.DEFERRED, PushRegistrationWork.run(context, generation, "T1", 0, register))
        ContinuityGuard.state = ContinuityGuard.State.NONE

        assertEquals(PushTokenState.Capture.Deferred("TOKEN_ACTOR_BUSY"), PushTokenState.captureTicket(context, generation, "T1", true) { true })

        reset()
        assertEquals(
            "RESET_PENDING comes first, whatever else holds",
            PushTokenState.Capture.Deferred("RESET_PENDING"),
            PushTokenState.captureTicket(context, generation, "T1", false) { true },
        )
        assertEquals(PushRegistrationWork.Outcome.DEFERRED, PushRegistrationWork.run(context, generation, "T1", 0, register))
        PushTokenState.completeReset(context)
        assertEquals(PushTokenState.Capture.Deferred("TOKEN_ROTATION_PENDING"), PushTokenState.captureTicket(context, generation, "T1", true) { false })
        assertEquals(0, requests)
    }

    @Test
    fun `T35 display is allowed only after a current-ticket 200, never by an authenticated page`() {
        val generation = started()
        reset()
        assertFalse(PushTokenState.displayAllowed(context))
        PushTokenState.completeReset(context)
        assertFalse("completion does not re-enable display", PushTokenState.displayAllowed(context))
        PushRegistration.onPageSettled(context, "${ru.yokoone.crm.shell.CrmOrigin.ORIGIN}/messages", "${PushRegistrar.SESSION_COOKIE_NAME}=v")
        assertFalse("an authenticated page does not re-enable display", PushTokenState.displayAllowed(context))

        provider.afterDelete = "T2"
        TokenActor.onRotationTrigger(context)
        EdgeTestSupport.idle()
        val current = state().sessionGeneration
        assertEquals(PushRegistrationWork.Outcome.SUCCESS, PushRegistrationWork.run(context, current, "T2", 0) { PushRegistrar.Outcome.Registered })
        assertTrue(PushTokenState.displayAllowed(context))
        assertTrue(generation <= current)
    }

    @Test
    fun `T59 the first 409 in a generation starts exactly one recovery, then the new token registers`() {
        val generation = started()
        provider.afterDelete = "T2"
        val outcome = PushRegistrationWork.run(context, generation, "T1", 0) {
            PushRegistrar.Outcome.Refused(PushTokenState.TOKEN_SCOPED_REASON)
        }
        assertEquals(PushRegistrationWork.Outcome.SUCCESS, outcome)
        EdgeTestSupport.idle()
        assertEquals("T2", state().newestToken)
        assertTrue(PushTokenState.isRetired(context, "T1"))
        assertNull("no block yet", state().blockedReason)
        assertEquals(PushRegistrationWork.Outcome.SUCCESS, PushRegistrationWork.run(context, generation, "T2", 0) { PushRegistrar.Outcome.Registered })
        assertTrue(state().isRegistered)
    }

    @Test
    fun `T60 a second 409 after the recovery blocks the generation with no further attempt`() {
        val generation = started()
        provider.afterDelete = "T2"
        PushRegistrationWork.run(context, generation, "T1", 0) { PushRegistrar.Outcome.Refused(PushTokenState.TOKEN_SCOPED_REASON) }
        EdgeTestSupport.idle()

        val outcome = PushRegistrationWork.run(context, generation, "T2", 0) { PushRegistrar.Outcome.Refused(PushTokenState.TOKEN_SCOPED_REASON) }
        assertEquals(PushRegistrationWork.Outcome.FAILURE, outcome)
        assertEquals(generation, state().conflictBlockedGeneration)
        assertFalse(state().needsRegistration)

        // Even a new token in this generation is not attempted.
        provider.current = "T3"
        PushRegistration.onNewToken(context, "T3")
        EdgeTestSupport.idle()
        var requests = 0
        assertEquals(
            PushRegistrationWork.Outcome.DEFERRED,
            PushRegistrationWork.run(context, generation, "T3", 0) { requests++; PushRegistrar.Outcome.Registered },
        )
        assertEquals(0, requests)
        assertTrue("one notice for this generation", PushTokenState.takeConflictNotice(context))
        assertFalse(PushTokenState.takeConflictNotice(context))

        // A new CRM login clears it by mismatch.
        val next = PushTokenState.startSessionGeneration(context).sessionGeneration
        assertTrue(state().needsRegistration)
        assertEquals(PushRegistrationWork.Outcome.SUCCESS, PushRegistrationWork.run(context, next, "T3", 0) { PushRegistrar.Outcome.Registered })
    }

    @Test
    fun `T65 work carrying a pre-reset pair sends nothing`() {
        val generation = started()
        reset()
        PushTokenState.completeReset(context)
        var requests = 0
        PushRegistrationWork.run(context, generation, "T1", 0) { requests++; PushRegistrar.Outcome.Registered }
        assertEquals(0, requests)
        assertNull(state().registeredToken)
    }

    @Test
    fun `T101 a late 409 for a superseded pair retires nothing and starts no rotation`() {
        val generation = started()
        val old = capture(generation, "T1")
        provider.current = "T2"
        PushRegistration.onNewToken(context, "T2")
        EdgeTestSupport.idle()

        assertEquals(PushTokenState.ConflictResult.STALE, PushTokenState.applyConflictIfCurrent(context, old))
        assertFalse(PushTokenState.isRetired(context, "T1"))
        assertFalse(state().rotationPending)
        assertNull(state().blockedReason)
    }

    @Test
    fun `T102 T111 a reset at any point of an in-flight registration voids its result`() {
        // After the request, before application: 200 and 409.
        for (reply in listOf(PushRegistrar.Outcome.Registered, PushRegistrar.Outcome.Refused(PushTokenState.TOKEN_SCOPED_REASON))) {
            EdgeTestSupport.reset(context)
            EdgeTestSupport.useProvider(provider)
            val generation = started()
            val outcome = PushRegistrationWork.run(context, generation, "T1", 0) {
                reset()
                reply
            }
            assertEquals(PushRegistrationWork.Outcome.SUCCESS, outcome)
            val s = state()
            assertFalse("$reply: display stays off", s.displayAllowed)
            assertNull("$reply: no binding resurrected", s.registeredToken)
            assertNull("$reply: no newest token", s.newestToken)
            assertNull("$reply: no block", s.blockedReason)
            assertEquals("$reply: reset still pending", EdgeContextReset.Reason.OPERATOR_SWITCH, s.resetPending)
            EdgeTestSupport.idle()
            assertEquals("$reply: no recovery job ran", 0, provider.deleteCalls)
        }

        // The response arrives after the relaunch completed the reset.
        EdgeTestSupport.reset(context)
        EdgeTestSupport.useProvider(provider)
        val generation = started()
        val ticket = capture(generation, "T1")
        reset()
        PushTokenState.completeReset(context)
        assertFalse(PushTokenState.applyRegisteredIfCurrent(context, ticket))
        assertEquals(PushTokenState.ConflictResult.STALE, PushTokenState.applyConflictIfCurrent(context, ticket))
        assertFalse(PushTokenState.displayAllowed(context))
    }

    @Test
    fun `T108 a delayed 409 of an older ticket after a newer 200 changes nothing`() {
        val generation = started()
        val older = capture(generation, "T1")
        val newer = capture(generation, "T1")
        assertTrue(PushTokenState.applyRegisteredIfCurrent(context, newer))

        assertEquals(PushTokenState.ConflictResult.STALE, PushTokenState.applyConflictIfCurrent(context, older))
        assertFalse(PushTokenState.applyBlockIfCurrent(context, older, "MOBILE_SESSION_REVOKED"))
        val s = state()
        assertTrue(s.isRegistered)
        assertTrue(s.displayAllowed)
        assertNull(s.blockedReason)
        assertFalse(PushTokenState.isRetired(context, "T1"))
    }

    @Test
    fun `T109 overlapping registrations of an old and a new token - only the current ticket applies, in both orders`() {
        for (newFirst in listOf(true, false)) {
            EdgeTestSupport.reset(context)
            EdgeTestSupport.useProvider(provider)
            val generation = started("T1")
            val oldTicket = capture(generation, "T1")
            provider.current = "T2"
            PushRegistration.onNewToken(context, "T2")
            EdgeTestSupport.idle()
            val newTicket = capture(generation, "T2")

            if (newFirst) {
                assertTrue(PushTokenState.applyRegisteredIfCurrent(context, newTicket))
                assertFalse(PushTokenState.applyRegisteredIfCurrent(context, oldTicket))
            } else {
                assertFalse(PushTokenState.applyRegisteredIfCurrent(context, oldTicket))
                assertTrue(PushTokenState.applyRegisteredIfCurrent(context, newTicket))
            }
            assertEquals("newFirst=$newFirst", "T2", state().registeredToken)
            assertEquals("newFirst=$newFirst", provider.current, state().registeredToken)
        }
    }

    @Test
    fun `T110 a response lost before application changes nothing and the next attempt uses a new ticket`() {
        val generation = started()
        val lost = capture(generation, "T1")
        // The process dies here: nothing is applied.
        assertTrue(state().needsRegistration)
        val next = capture(generation, "T1")
        assertTrue(next.seq > lost.seq)
        assertTrue(PushTokenState.applyRegisteredIfCurrent(context, next))
        assertFalse("no duplicate effect from the older ticket", PushTokenState.applyRegisteredIfCurrent(context, lost))
    }
}
