package ru.yokoone.crm.shell.push

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import ru.yokoone.crm.shell.ContinuityGuard
import ru.yokoone.crm.shell.EdgeContextReset
import ru.yokoone.crm.shell.EdgeTestSupport
import ru.yokoone.crm.shell.ShellKeys
import java.util.Collections
import kotlin.random.Random

/**
 * The serial token actor (R5.1 §5.7.2, INV-20, INV-22) against a controllable
 * provider: T100, T100b–T100e, T112, T114–T118, T64, T66, T67, T93, T94.
 *
 * In manual mode each deleteToken/getToken completes only when the test
 * releases it, so the interleavings the design names are driven explicitly.
 */
@RunWith(RobolectricTestRunner::class)
class TokenActorTest {

    private val context: Context get() = ApplicationProvider.getApplicationContext()
    private lateinit var provider: EdgeTestSupport.FakeProvider
    private lateinit var keys: EdgeTestSupport.MemoryKeys
    private val scheduled: MutableList<Pair<Long, String>> = Collections.synchronizedList(mutableListOf())
    private val realScheduler = PushRegistration.scheduler

    @Before
    fun setUp() {
        fresh()
        PushRegistration.scheduler = PushRegistration.Scheduler { _, generation, token -> scheduled += generation to token }
    }

    @After
    fun tearDown() {
        provider.releaseAll()
        EdgeTestSupport.idle()
        EdgeTestSupport.useProvider(null)
        PushRegistration.scheduler = realScheduler
    }

    private fun fresh() {
        if (::provider.isInitialized) provider.releaseAll()
        keys = EdgeTestSupport.reset(context)
        provider = EdgeTestSupport.FakeProvider()
        EdgeTestSupport.useProvider(provider)
        scheduled.clear()
    }

    private fun state() = PushTokenState.snapshot(context)
    private fun newest() = state().newestToken
    private fun idle() = EdgeTestSupport.idle()

    /** The provider holds [token]; the actor reads and commits it. */
    private fun deliver(token: String) {
        provider.auto = true
        provider.current = token
        PushRegistration.onNewToken(context, token)
        idle()
        assertEquals(token, newest())
    }

    /** A reset in this process (step 0) and its completion in the next one (§5.3a). */
    private fun resetAndRelaunch(reason: String = EdgeContextReset.Reason.OPERATOR_SWITCH) {
        PushTokenState.beginReset(context, reason, System.currentTimeMillis(), 0L)
        PushTokenState.completeReset(context)
        TokenActor.resetForTest()
        EdgeTestSupport.useProvider(provider)
    }

    private fun registerOnce(token: String): PushRegistrationWork.Outcome {
        val generation = PushTokenState.startSessionGeneration(context).sessionGeneration
        return PushRegistrationWork.run(context, generation, token, 0) { PushRegistrar.Outcome.Registered }
    }

    @Test
    fun `T100b a token issued during the delete is a signal only - the job commits what the provider holds after it`() {
        for (signalAt in 0..1) {
            for (lateAt in 0..2) {
                fresh()
                deliver("t1")

                // An older job whose getToken() timed out; its listener fires late with t1.
                provider.auto = false
                TokenActor.getTimeoutMs = 50
                PushRegistration.onNewToken(context, "t1")
                val lateT1 = provider.awaitGet()
                idle()
                TokenActor.getTimeoutMs = TokenActor.GET_TIMEOUT_MS

                resetAndRelaunch()
                assertTrue(PushTokenState.isRetired(context, "t1"))
                provider.auto = false
                provider.current = "t2" // Firebase auto-init issued t2 at start
                TokenActor.onRotationTrigger(context)
                val delete = provider.awaitDelete()

                if (lateAt == 0) lateT1("t1")
                if (signalAt == 0) PushRegistration.onNewToken(context, "t2")
                assertNotEquals("t2", newest())

                // The delete removes t2; the provider will issue t3.
                provider.current = "t3"
                delete(true)
                val get = provider.awaitGet()
                if (lateAt == 1) lateT1("t1")
                if (signalAt == 1) PushRegistration.onNewToken(context, "t2")
                assertNotEquals("t2", newest())
                get(provider.current)

                // The queued REFRESH re-reads the provider.
                provider.completeGet()
                idle()
                if (lateAt == 2) lateT1("t1")
                idle()

                val case = "signalAt=$signalAt lateAt=$lateAt"
                assertEquals(case, "t3", newest())
                assertEquals(case, "t3", provider.current)
                assertFalse(case, state().rotationPending)
                ContinuityGuard.state = ContinuityGuard.State.NONE
                assertEquals(case, PushRegistrationWork.Outcome.SUCCESS, registerOnce("t3"))
                assertEquals(case, "t3", state().registeredToken)
            }
        }
    }

    @Test
    fun `T100c a late getToken result of a timed-out job is ignored after a newer commit`() {
        provider.auto = false
        TokenActor.getTimeoutMs = 50
        PushRegistration.onNewToken(context, "x")
        val late = provider.awaitGet()
        idle()
        TokenActor.getTimeoutMs = TokenActor.GET_TIMEOUT_MS

        provider.current = "tB"
        PushRegistration.onNewToken(context, "x")
        provider.completeGet()
        idle()
        assertEquals("tB", newest())

        late("tA-old")
        idle()
        assertEquals("tB", newest())
    }

    @Test
    fun `T100d T64 a retired value delivered during ROTATE is never committed`() {
        deliver("t1")
        resetAndRelaunch()
        provider.auto = true
        provider.current = "t1"
        // The first delete leaves the provider on the retired token, the second issues t4.
        provider.afterDeleteSequence.add("t1")
        provider.afterDeleteSequence.add("t4")
        PushRegistration.onNewToken(context, "t1")
        TokenActor.onRotationTrigger(context)
        PushRegistration.onNewToken(context, "t1")
        idle()

        assertEquals("t4", newest())
        assertFalse(state().rotationPending)
        assertFalse(PushTokenState.isRetired(context, "t4"))
    }

    @Test
    fun `T100e a storm of signals queues at most one REFRESH and commits the provider's token once`() {
        provider.auto = false
        provider.current = "tS"
        PushRegistration.onNewToken(context, "s0")
        val first = provider.awaitGet()
        repeat(10) { PushRegistration.onNewToken(context, "s${it + 1}") }
        assertEquals(listOf(TokenActor.Kind.REFRESH), TokenActor.queuedKinds())

        first(provider.current)
        provider.completeGet()
        idle()

        assertEquals(2, provider.getCalls)
        assertEquals("tS", newest())
    }

    @Test
    fun `T66 a provider that keeps the retired token is stopped after two rounds, pending kept, nothing registered`() {
        deliver("t1")
        val generation = PushTokenState.startSessionGeneration(context).sessionGeneration
        resetAndRelaunch()
        scheduled.clear()
        provider.auto = true
        provider.current = "t1"
        provider.afterDelete = "t1"

        TokenActor.onRotationTrigger(context)
        idle()

        assertEquals(TokenActor.MAX_ROTATION_ROUNDS, provider.deleteCalls)
        assertTrue(state().rotationPending)
        assertNull(newest())
        assertTrue(scheduled.isEmpty())
        var sent = false
        assertEquals(
            PushRegistrationWork.Outcome.DEFERRED,
            PushRegistrationWork.run(context, generation, "t1", 0) { sent = true; PushRegistrar.Outcome.Registered },
        )
        assertFalse(sent)
    }

    @Test
    fun `T100 two triggers, a signal and a 409 recovery - no delete after pending cleared, stored = registered = provider`() {
        deliver("t1")
        val generation = PushTokenState.startSessionGeneration(context).sessionGeneration
        provider.auto = true
        provider.afterDelete = "t2"

        val outcome = PushRegistrationWork.run(context, generation, "t1", 0) {
            PushRegistrar.Outcome.Refused(PushTokenState.TOKEN_SCOPED_REASON)
        }
        assertEquals(PushRegistrationWork.Outcome.SUCCESS, outcome)
        idle()
        assertEquals("t2", newest())
        assertEquals(1, provider.deleteCalls)

        TokenActor.onRotationTrigger(context)
        PushRegistration.onNewToken(context, "t2")
        TokenActor.onRotationTrigger(context)
        idle()
        assertEquals("deleteToken() never runs once pending is clear", 1, provider.deleteCalls)

        assertEquals(PushRegistrationWork.Outcome.SUCCESS, PushRegistrationWork.run(context, generation, "t2", 0) { PushRegistrar.Outcome.Registered })
        assertEquals("t2", state().registeredToken)
        assertEquals(provider.current, state().registeredToken)
    }

    @Test
    fun `T112 T115 jobs admitted before a reset never commit after it, the job after the last reset does`() {
        deliver("t1")
        resetAndRelaunch()
        provider.auto = false
        TokenActor.onRotationTrigger(context)
        val delete = provider.awaitDelete()
        PushRegistration.onNewToken(context, "tz")

        // A second automatic reset within 60 s is refused by the guard; an explicit one runs.
        assertFalse(EdgeContextReset.automaticAllowed(PushTokenState.lastReset(context), System.currentTimeMillis(), 0L))
        PushTokenState.beginReset(context, EdgeContextReset.Reason.OPERATOR_SWITCH, System.currentTimeMillis(), 0L)
        PushTokenState.beginReset(context, EdgeContextReset.Reason.OPERATOR_SWITCH, System.currentTimeMillis(), 0L)
        PushTokenState.completeReset(context)

        provider.current = "tY"
        delete(true)
        provider.completeGet() // the old ROTATE's get: epoch mismatch
        provider.completeGet() // the queued REFRESH, admitted after the resets
        idle()
        assertEquals("the job admitted after the last reset commits", "tY", newest())
        assertNull(state().resetPending)
        assertEquals(3L, state().resetEpoch)
    }

    @Test
    fun `T112 a commit from a job whose epoch moved is rejected`() {
        val epoch = PushTokenState.resetEpoch(context)
        PushTokenState.beginReset(context, EdgeContextReset.Reason.SESSION_ENDED, 1L, 1L)
        PushTokenState.completeReset(context)
        val result = PushTokenState.commitToken(context, epoch, PushTokenState.CommitKind.ROTATE, "tX", deleteSucceeded = true)
        assertEquals(PushTokenState.CommitResult.Rejected("epoch"), result)
        assertNull(newest())
    }

    @Test
    fun `T114 a pending rotation survives the process and the next start commits the provider's current token`() {
        deliver("t1")
        PushTokenState.beginReset(context, EdgeContextReset.Reason.EDGE_MAX_AGE, 1L, 1L)
        // Nothing commits while reset_pending is set (the dying process).
        assertEquals(
            PushTokenState.CommitResult.Rejected("reset-pending"),
            PushTokenState.commitToken(context, state().resetEpoch, PushTokenState.CommitKind.ROTATE, "t9", true),
        )
        PushTokenState.completeReset(context)
        assertTrue(state().rotationPending)

        // Next process start.
        TokenActor.resetForTest()
        EdgeTestSupport.useProvider(provider)
        provider.auto = true
        provider.current = "t1"
        provider.afterDelete = "t5"
        TokenActor.onMainProcessStart(context)
        idle()
        assertEquals("t5", newest())
        assertEquals(provider.current, newest())
        assertFalse(state().rotationPending)
    }

    @Test
    fun `T116 a RETIRE_AND_ROTATE whose ticket went stale before it started does nothing`() {
        deliver("t1")
        val generation = PushTokenState.startSessionGeneration(context).sessionGeneration
        val ticket = (PushTokenState.captureTicket(context, generation, "t1", true) { false } as PushTokenState.Capture.Captured).ticket
        assertEquals(PushTokenState.ConflictResult.RECOVER, PushTokenState.applyConflictIfCurrent(context, ticket))

        // A REFRESH is ahead in the queue and commits a new token before the job starts.
        provider.auto = false
        provider.current = "t2"
        PushRegistration.onNewToken(context, "t2")
        val get = provider.awaitGet()
        TokenActor.enqueueRetireAndRotate(context, ticket)
        get("t2")
        idle()

        assertEquals("t2", newest())
        assertEquals("no provider call by the stale job", 0, provider.deleteCalls)
        assertFalse("the newer token is not retired", PushTokenState.isRetired(context, "t2"))
        assertFalse("rotation not started", state().rotationPending)
        assertEquals("nothing retired", 0, PushTokenState.retiredCount(context))
        // rotation_recoveries unchanged: the one recovery is still available for this generation.
        val second = (PushTokenState.captureTicket(context, generation, "t2", true) { false } as PushTokenState.Capture.Captured).ticket
        assertEquals(PushTokenState.ConflictResult.RECOVER, PushTokenState.applyConflictIfCurrent(context, second))
    }

    @Test
    fun `T117 a registration while the actor is busy defers without a request, then registers once idle`() {
        deliver("t1")
        val generation = PushTokenState.startSessionGeneration(context).sessionGeneration
        provider.auto = false
        PushRegistration.onNewToken(context, "t1")
        val get = provider.awaitGet()
        TokenActor.onRotationTrigger(context) // not pending: no-op
        // Force a rotation-family job into the queue behind the running REFRESH.
        val stale = PushTokenState.Ticket(state().resetEpoch, generation, "t1", Long.MAX_VALUE)
        TokenActor.enqueueRetireAndRotate(context, stale)
        assertTrue(TokenActor.isBusyForRegistration())

        var requests = 0
        val deferred = PushRegistrationWork.run(context, generation, "t1", 0) { requests++; PushRegistrar.Outcome.Registered }
        assertEquals(PushRegistrationWork.Outcome.DEFERRED, deferred)
        assertEquals(0, requests)
        assertNull("no block", state().blockedReason)

        get("t1")
        idle()
        assertFalse(TokenActor.isBusyForRegistration())
        assertEquals(PushRegistrationWork.Outcome.SUCCESS, PushRegistrationWork.run(context, generation, "t1", 0) { requests++; PushRegistrar.Outcome.Registered })
        assertEquals(1, requests)
        assertTrue(state().isRegistered)
    }

    @Test
    fun `T118 restored work with a pre-death pair sends nothing until a current ticket exists`() {
        deliver("t1")
        val generation = PushTokenState.startSessionGeneration(context).sessionGeneration
        resetAndRelaunch()
        var requests = 0
        val register: (String) -> PushRegistrar.Outcome = { requests++; PushRegistrar.Outcome.Registered }

        // WorkManager restores (generation, t1) while rotation is pending.
        assertEquals(PushRegistrationWork.Outcome.DEFERRED, PushRegistrationWork.run(context, generation, "t1", 0, register))
        provider.auto = true
        provider.afterDelete = "t7"
        TokenActor.onRotationTrigger(context)
        idle()
        // The restored token is retired: still nothing on the wire.
        assertEquals(PushRegistrationWork.Outcome.DEFERRED, PushRegistrationWork.run(context, generation, "t1", 0, register))
        assertEquals(0, requests)
        // One registration of the provider's current token under the current pair.
        assertEquals(PushRegistrationWork.Outcome.SUCCESS, PushRegistrationWork.run(context, generation, "t7", 0, register))
        assertEquals(1, requests)
        assertEquals("t7", state().registeredToken)
    }

    @Test
    fun `T93 a lost K_install stops the token path until a recovery with a confirmed delete`() {
        deliver("t1")
        val generation = PushTokenState.startSessionGeneration(context).sessionGeneration
        keys.keys.keys.filter { it.startsWith(ShellKeys.INSTALL_ALIAS_PREFIX) }.forEach { keys.keys.remove(it) }
        assertTrue(PushTokenState.installKeyBroken(context))

        var requests = 0
        assertEquals(
            PushRegistrationWork.Outcome.DEFERRED,
            PushRegistrationWork.run(context, generation, "t1", 0) { requests++; PushRegistrar.Outcome.Registered },
        )
        assertEquals(0, requests)

        // T94: offline - the delete fails, nothing is accepted.
        provider.auto = true
        provider.deleteSucceeds = false
        TokenActor.onRotationTrigger(context)
        idle()
        assertTrue(state().installKeyRecoveryPending)
        assertEquals("t1", newest())

        // Online - a confirmed delete, then the provider's new token.
        provider.deleteSucceeds = true
        provider.afterDelete = "t8"
        TokenActor.onRotationTrigger(context)
        idle()
        assertFalse(state().installKeyRecoveryPending)
        assertFalse(state().rotationPending)
        assertEquals("t8", newest())
        assertEquals(PushRegistrationWork.Outcome.SUCCESS, PushRegistrationWork.run(context, generation, "t8", 0) { requests++; PushRegistrar.Outcome.Registered })
        assertEquals(1, requests)
    }

    @Test
    fun `T67 over random interleavings no request ever carries a retired token`() {
        val random = Random(20261027)
        val retiredEver = HashSet<String>()
        var counter = 0
        fun freshToken() = "tok-${counter++}"
        provider.auto = true
        provider.current = freshToken()
        ContinuityGuard.state = ContinuityGuard.State.NONE
        repeat(300) {
            when (random.nextInt(7)) {
                0 -> {
                    val s = state()
                    listOfNotNull(s.newestToken, s.registeredToken).forEach { retiredEver += it }
                    resetAndRelaunch()
                    ContinuityGuard.state = ContinuityGuard.State.NONE
                    TokenActor.onRotationTrigger(context)
                }
                1 -> {
                    provider.current = freshToken()
                    PushRegistration.onNewToken(context, provider.current!!)
                }
                2 -> provider.afterDelete = if (random.nextBoolean()) freshToken() else provider.current
                3 -> PushTokenState.startSessionGeneration(context)
                4, 5 -> {
                    val s = state()
                    val token = if (random.nextBoolean()) s.newestToken else retiredEver.randomOrNull(random)
                    if (token != null && s.sessionGeneration != PushTokenState.NO_GENERATION) {
                        PushRegistrationWork.run(context, s.sessionGeneration, token, 0) { sent ->
                            assertFalse("a retired token reached the network: step $it", sent in retiredEver)
                            if (random.nextInt(4) == 0) {
                                PushRegistrar.Outcome.Refused(PushTokenState.TOKEN_SCOPED_REASON)
                            } else {
                                PushRegistrar.Outcome.Registered
                            }
                        }
                    }
                }
                6 -> TokenActor.onRotationTrigger(context)
            }
            idle()
        }
    }
}
