package ru.yokoone.crm.shell

import android.os.Handler
import android.os.Looper
import android.webkit.CookieManager
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.FixMethodOrder
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.runners.MethodSorters
import ru.yokoone.crm.shell.EdgeDeviceSupport.FakeProvider
import ru.yokoone.crm.shell.EdgeDeviceSupport.context
import ru.yokoone.crm.shell.push.PushRegistrar
import ru.yokoone.crm.shell.push.PushRegistration
import ru.yokoone.crm.shell.push.PushRegistrationWork
import ru.yokoone.crm.shell.push.PushTokenState
import ru.yokoone.crm.shell.push.TokenActor
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * I layer, in process: the token actor, the tickets, the reset intent, the
 * Keystore-keyed record and the verified cookie removal on a real Android
 * system — real ART threads, real Android Keystore, real CookieManager.
 *
 * The scenarios mirror their JVM counterparts (T100b–T100e, T112, T114–T118,
 * T101/T108, T102, T93/T94, T77/T97, T38) so a platform difference would show
 * as a disagreement between the two layers.
 */
@RunWith(AndroidJUnit4::class)
@FixMethodOrder(MethodSorters.NAME_ASCENDING)
class EdgeDeviceTest {

    private lateinit var provider: FakeProvider
    private val realScheduler = PushRegistration.scheduler

    @Before
    fun setUp() {
        EdgeDeviceSupport.reset()
        provider = FakeProvider()
        EdgeDeviceSupport.useProvider(provider)
        PushRegistration.scheduler = PushRegistration.Scheduler { _, _, _ -> }
    }

    @After
    fun tearDown() {
        provider.releaseAll()
        EdgeDeviceSupport.idle()
        EdgeDeviceSupport.useProvider(null)
        PushRegistration.scheduler = realScheduler
        EdgeDeviceSupport.reset()
    }

    private fun state() = PushTokenState.snapshot(context)
    private fun newest() = state().newestToken
    private fun idle() = EdgeDeviceSupport.idle()

    private fun deliver(token: String) {
        provider.auto = true
        provider.current = token
        PushRegistration.onNewToken(context, token)
        idle()
        assertEquals(token, newest())
    }

    private fun resetAndRelaunch() {
        PushTokenState.beginReset(context, EdgeContextReset.Reason.OPERATOR_SWITCH, System.currentTimeMillis(), 0L)
        PushTokenState.completeReset(context)
        TokenActor.resetForTest()
        EdgeDeviceSupport.useProvider(provider)
    }

    private fun registerOnce(token: String): PushRegistrationWork.Outcome {
        val generation = PushTokenState.startSessionGeneration(context).sessionGeneration
        return PushRegistrationWork.run(context, generation, token, 0) { PushRegistrar.Outcome.Registered }
    }

    @Test
    fun i01_T100b_signalOnlyDuringDelete_commitsProviderTruth() {
        for (signalAt in 0..1) for (lateAt in 0..2) {
            if (signalAt + lateAt > 0) { provider.releaseAll(); EdgeDeviceSupport.reset(); provider = FakeProvider(); EdgeDeviceSupport.useProvider(provider) }
            deliver("t1")
            provider.auto = false
            TokenActor.getTimeoutMs = 50
            PushRegistration.onNewToken(context, "t1")
            val lateT1 = provider.awaitGet()
            idle()
            TokenActor.getTimeoutMs = TokenActor.GET_TIMEOUT_MS
            resetAndRelaunch()
            assertTrue(PushTokenState.isRetired(context, "t1"))
            provider.auto = false
            provider.current = "t2"
            TokenActor.onRotationTrigger(context)
            val delete = provider.awaitDelete()
            if (lateAt == 0) lateT1("t1")
            if (signalAt == 0) PushRegistration.onNewToken(context, "t2")
            assertNotEquals("t2", newest())
            provider.current = "t3"
            delete(true)
            val get = provider.awaitGet()
            if (lateAt == 1) lateT1("t1")
            if (signalAt == 1) PushRegistration.onNewToken(context, "t2")
            assertNotEquals("t2", newest())
            get(provider.current)
            provider.completeGet()
            idle()
            if (lateAt == 2) lateT1("t1")
            idle()
            val case = "signalAt=$signalAt lateAt=$lateAt"
            assertEquals(case, "t3", newest())
            assertFalse(case, state().rotationPending)
            ContinuityGuard.state = ContinuityGuard.State.NONE
            assertEquals(case, PushRegistrationWork.Outcome.SUCCESS, registerOnce("t3"))
            assertEquals(case, "t3", state().registeredToken)
        }
        EdgeDeviceSupport.mark("I01 T100b PASS")
    }

    @Test
    fun i02_T100c_lateGetAfterNewerCommitIgnored() {
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
        late("tA-old")
        idle()
        assertEquals("tB", newest())
        EdgeDeviceSupport.mark("I02 T100c PASS")
    }

    @Test
    fun i03_T100d_retiredValueNeverCommitted() {
        deliver("t1")
        resetAndRelaunch()
        provider.auto = true
        provider.current = "t1"
        provider.afterDeleteSequence.add("t1")
        provider.afterDeleteSequence.add("t4")
        PushRegistration.onNewToken(context, "t1")
        TokenActor.onRotationTrigger(context)
        PushRegistration.onNewToken(context, "t1")
        idle()
        assertEquals("t4", newest())
        assertFalse(PushTokenState.isRetired(context, "t4"))
        EdgeDeviceSupport.mark("I03 T100d PASS")
    }

    @Test
    fun i04_T100e_signalStormCoalesces() {
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
        EdgeDeviceSupport.mark("I04 T100e PASS")
    }

    @Test
    fun i05_T114_pendingRotationSurvivesAndNextStartCommits() {
        deliver("t1")
        PushTokenState.beginReset(context, EdgeContextReset.Reason.EDGE_MAX_AGE, 1L, 1L)
        assertEquals(
            PushTokenState.CommitResult.Rejected("reset-pending"),
            PushTokenState.commitToken(context, state().resetEpoch, PushTokenState.CommitKind.ROTATE, "t9", true),
        )
        PushTokenState.completeReset(context)
        TokenActor.resetForTest()
        EdgeDeviceSupport.useProvider(provider)
        provider.auto = true
        provider.current = "t1"
        provider.afterDelete = "t5"
        TokenActor.onMainProcessStart(context)
        idle()
        assertEquals("t5", newest())
        assertFalse(state().rotationPending)
        EdgeDeviceSupport.mark("I05 T114 PASS")
    }

    @Test
    fun i06_T112_T115_jobsBeforeResetNeverCommit() {
        deliver("t1")
        resetAndRelaunch()
        provider.auto = false
        TokenActor.onRotationTrigger(context)
        val delete = provider.awaitDelete()
        PushRegistration.onNewToken(context, "tz")
        assertFalse(EdgeContextReset.automaticAllowed(PushTokenState.lastReset(context), System.currentTimeMillis(), 0L))
        PushTokenState.beginReset(context, EdgeContextReset.Reason.OPERATOR_SWITCH, System.currentTimeMillis(), 0L)
        PushTokenState.beginReset(context, EdgeContextReset.Reason.OPERATOR_SWITCH, System.currentTimeMillis(), 0L)
        PushTokenState.completeReset(context)
        provider.current = "tY"
        delete(true)
        provider.completeGet()
        provider.completeGet()
        idle()
        assertEquals("tY", newest())
        assertEquals(3L, state().resetEpoch)
        EdgeDeviceSupport.mark("I06 T112/T115 PASS")
    }

    @Test
    fun i07_T116_staleRetireAndRotateDoesNothing() {
        deliver("t1")
        val generation = PushTokenState.startSessionGeneration(context).sessionGeneration
        val ticket = (PushTokenState.captureTicket(context, generation, "t1", true) { false } as PushTokenState.Capture.Captured).ticket
        assertEquals(PushTokenState.ConflictResult.RECOVER, PushTokenState.applyConflictIfCurrent(context, ticket))
        provider.auto = false
        provider.current = "t2"
        PushRegistration.onNewToken(context, "t2")
        val get = provider.awaitGet()
        TokenActor.enqueueRetireAndRotate(context, ticket)
        get("t2")
        idle()
        assertEquals("t2", newest())
        assertEquals(0, provider.deleteCalls)
        assertFalse(PushTokenState.isRetired(context, "t2"))
        assertFalse(state().rotationPending)
        EdgeDeviceSupport.mark("I07 T116 PASS")
    }

    @Test
    fun i08_T117_registrationDefersWhileActorBusy() {
        deliver("t1")
        val generation = PushTokenState.startSessionGeneration(context).sessionGeneration
        provider.auto = false
        PushRegistration.onNewToken(context, "t1")
        val get = provider.awaitGet()
        TokenActor.enqueueRetireAndRotate(context, PushTokenState.Ticket(state().resetEpoch, generation, "t1", Long.MAX_VALUE))
        var requests = 0
        assertEquals(PushRegistrationWork.Outcome.DEFERRED, PushRegistrationWork.run(context, generation, "t1", 0) { requests++; PushRegistrar.Outcome.Registered })
        assertEquals(0, requests)
        get("t1")
        idle()
        assertEquals(PushRegistrationWork.Outcome.SUCCESS, PushRegistrationWork.run(context, generation, "t1", 0) { requests++; PushRegistrar.Outcome.Registered })
        assertEquals(1, requests)
        EdgeDeviceSupport.mark("I08 T117 PASS")
    }

    @Test
    fun i09_T118_restoredPairSendsNothingUntilCurrentTicket() {
        deliver("t1")
        val generation = PushTokenState.startSessionGeneration(context).sessionGeneration
        resetAndRelaunch()
        var requests = 0
        val register: (String) -> PushRegistrar.Outcome = { requests++; PushRegistrar.Outcome.Registered }
        assertEquals(PushRegistrationWork.Outcome.DEFERRED, PushRegistrationWork.run(context, generation, "t1", 0, register))
        provider.auto = true
        provider.afterDelete = "t7"
        TokenActor.onRotationTrigger(context)
        idle()
        assertEquals(PushRegistrationWork.Outcome.DEFERRED, PushRegistrationWork.run(context, generation, "t1", 0, register))
        assertEquals(0, requests)
        assertEquals(PushRegistrationWork.Outcome.SUCCESS, PushRegistrationWork.run(context, generation, "t7", 0, register))
        assertEquals(1, requests)
        EdgeDeviceSupport.mark("I09 T118 PASS")
    }

    @Test
    fun i10_T101_T108_late409ChangesNothing() {
        deliver("t1")
        val generation = PushTokenState.startSessionGeneration(context).sessionGeneration
        val older = (PushTokenState.captureTicket(context, generation, "t1", true) { false } as PushTokenState.Capture.Captured).ticket
        val newer = (PushTokenState.captureTicket(context, generation, "t1", true) { false } as PushTokenState.Capture.Captured).ticket
        assertTrue(PushTokenState.applyRegisteredIfCurrent(context, newer))
        assertEquals(PushTokenState.ConflictResult.STALE, PushTokenState.applyConflictIfCurrent(context, older))
        assertTrue(state().isRegistered)
        assertFalse(PushTokenState.isRetired(context, "t1"))
        assertFalse(state().rotationPending)
        EdgeDeviceSupport.mark("I10 T101/T108 PASS")
    }

    @Test
    fun i11_T102_resetDuringRegistrationVoidsResult() {
        deliver("t1")
        val generation = PushTokenState.startSessionGeneration(context).sessionGeneration
        val outcome = PushRegistrationWork.run(context, generation, "t1", 0) {
            PushTokenState.beginReset(context, EdgeContextReset.Reason.OPERATOR_SWITCH, System.currentTimeMillis(), 0L)
            PushRegistrar.Outcome.Registered
        }
        assertEquals(PushRegistrationWork.Outcome.SUCCESS, outcome)
        val s = state()
        assertFalse(s.displayAllowed)
        assertNull(s.registeredToken)
        assertNull(s.newestToken)
        assertEquals(EdgeContextReset.Reason.OPERATOR_SWITCH, s.resetPending)
        EdgeDeviceSupport.mark("I11 T102 PASS")
    }

    @Test
    fun i12_T93_T94_realKeystoreInstallKeyLossAndRecovery() {
        deliver("t1")
        assertEquals(1, EdgeDeviceSupport.shellAliases(ShellKeys.INSTALL_ALIAS_PREFIX).size)
        val generation = PushTokenState.startSessionGeneration(context).sessionGeneration
        EdgeDeviceSupport.deleteShellKeys(ShellKeys.INSTALL_ALIAS_PREFIX)
        assertTrue(PushTokenState.installKeyBroken(context))
        var requests = 0
        assertEquals(PushRegistrationWork.Outcome.DEFERRED, PushRegistrationWork.run(context, generation, "t1", 0) { requests++; PushRegistrar.Outcome.Registered })
        provider.auto = true
        provider.deleteSucceeds = false
        TokenActor.onRotationTrigger(context)
        idle()
        assertTrue(state().installKeyRecoveryPending)
        provider.deleteSucceeds = true
        provider.afterDelete = "t8"
        TokenActor.onRotationTrigger(context)
        idle()
        assertFalse(state().installKeyRecoveryPending)
        assertEquals("t8", newest())
        assertEquals(PushRegistrationWork.Outcome.SUCCESS, PushRegistrationWork.run(context, generation, "t8", 0) { requests++; PushRegistrar.Outcome.Registered })
        assertEquals(1, requests)
        assertTrue("a fresh Android Keystore alias generation exists", EdgeDeviceSupport.shellAliases(ShellKeys.INSTALL_ALIAS_PREFIX).isNotEmpty())
        EdgeDeviceSupport.mark("I12 T93/T94 PASS")
    }

    @Test
    fun i13_T77_T97_realKeystoreRecordAndKeyLoss() {
        assertEquals(ContinuityGuard.WriteResult.WRITTEN, ContinuityGuard.writeRecord(context, "staff.a"))
        val (stored, verification) = ContinuityGuard.verifyStored(context)
        assertTrue(stored)
        assertTrue(verification is ContinuityRecord.Verification.Valid)
        val probe = ContinuityGuard.precheck(true, stored, verification, PushTokenState.installKeyAvailable(context), ContinuityGuard.EdgeGate.PRESENT, ContinuityGuard.noEdgeFingerprint(context))
        assertTrue("got $probe", probe is ContinuityGuard.Precheck.Probe)
        EdgeDeviceSupport.deleteShellKeys(ShellKeys.CONTEXT_ALIAS_PREFIX)
        val (stored2, verification2) = ContinuityGuard.verifyStored(context)
        val decision = ContinuityGuard.precheck(true, stored2, verification2, PushTokenState.installKeyAvailable(context), ContinuityGuard.EdgeGate.PRESENT, ContinuityGuard.noEdgeFingerprint(context))
        assertEquals(ContinuityGuard.Precheck.Mismatch("record-key"), decision)
        EdgeDeviceSupport.mark("I13 T77/T97 PASS")
    }

    @Test
    fun i14_T38_realCookieManagerRemovalIsVerified() {
        val jar = CookieManager.getInstance()
        jar.setCookie(CrmOrigin.ORIGIN, "${PushRegistrar.SESSION_COOKIE_NAME}=i14-session; Path=/")
        jar.setCookie(CrmOrigin.ORIGIN, "crm_user_id=i14; Path=/")
        jar.flush()
        assertTrue(jar.getCookie(CrmOrigin.ORIGIN).orEmpty().contains(PushRegistrar.SESSION_COOKIE_NAME))
        val done = CountDownLatch(1)
        var verified: Boolean? = null
        val main = Handler(Looper.getMainLooper())
        val realJar = object : EdgeContextReset.CookieJar {
            override fun removeAll(done: () -> Unit) { jar.removeAllCookies { done() } }
            override fun flush() = jar.flush()
            override fun cookiesFor(url: String): String? = jar.getCookie(url)
        }
        main.post {
            EdgeContextReset.verifyCookieRemoval(realJar, { delay, block -> main.postDelayed(block, delay) }, { verified = it; done.countDown() })
        }
        assertTrue("verification did not finish", done.await(20, TimeUnit.SECONDS))
        assertEquals(true, verified)
        assertTrue(jar.getCookie(CrmOrigin.ORIGIN).isNullOrEmpty())
        EdgeDeviceSupport.mark("I14 T38 PASS")
    }

    @Test
    fun i15_step0IsOneDurableCommitOnDevice() {
        deliver("t1")
        val generation = PushTokenState.startSessionGeneration(context).sessionGeneration
        assertTrue(PushTokenState.applyRegisteredIfCurrent(context, generation, "t1"))
        ContinuityGuard.writeRecord(context, "staff.a")
        PushTokenState.beginReset(context, EdgeContextReset.Reason.SESSION_ENDED, 42L, 7L)
        val s = state()
        assertEquals(EdgeContextReset.Reason.SESSION_ENDED, s.resetPending)
        assertFalse(s.displayAllowed)
        assertTrue(s.rotationPending)
        assertNull(s.newestToken)
        assertNull(s.registeredToken)
        assertTrue(PushTokenState.isRetired(context, "t1"))
        assertNull(PushTokenState.continuityRecord(context).body)
        EdgeDeviceSupport.mark("I15 step0 PASS")
    }
}
