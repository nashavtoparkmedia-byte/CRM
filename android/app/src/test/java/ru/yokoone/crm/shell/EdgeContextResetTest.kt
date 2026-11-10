package ru.yokoone.crm.shell

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
import ru.yokoone.crm.shell.push.PushTokenState

/**
 * The edge context reset (R5.1 §5.3, §5.3a, §5.5): step 0 in one commit, the
 * verified cookie removal, the loop guard and the shortcut limit. T33, T38a,
 * T38c (unit part), T102 (step 0 part).
 */
@RunWith(RobolectricTestRunner::class)
class EdgeContextResetTest {

    private val context: Context get() = ApplicationProvider.getApplicationContext()
    private lateinit var keys: EdgeTestSupport.MemoryKeys

    @Before
    fun setUp() {
        keys = EdgeTestSupport.reset(context)
    }

    /** A cookie store whose removal can be delayed, ignored or partial. */
    private class FakeJar(var cookies: MutableMap<String, String?>) : EdgeContextReset.CookieJar {
        var removeCalls = 0
        var flushes = 0
        var callbackDelivered = true
        var removalWorks = true
        val pendingCallbacks = mutableListOf<() -> Unit>()
        override fun removeAll(done: () -> Unit) {
            removeCalls += 1
            if (removalWorks) cookies.keys.toList().forEach { cookies[it] = null }
            if (callbackDelivered) done() else pendingCallbacks += done
        }
        override fun flush() {
            flushes += 1
        }
        override fun cookiesFor(url: String): String? = cookies[url]
    }

    /** Runs scheduled blocks in order of their delay, like a looper on a fake clock. */
    private class FakeScheduler {
        val tasks = mutableListOf<Pair<Long, () -> Unit>>()
        var now = 0L
        fun schedule(delay: Long, block: () -> Unit) {
            tasks += (now + delay) to block
        }
        fun runAll() {
            while (tasks.isNotEmpty()) {
                val next = tasks.minByOrNull { it.first }!!
                tasks.remove(next)
                now = next.first
                next.second()
            }
        }
    }

    private val origin = CrmOrigin.ORIGIN
    private val alias = EdgeContextReset.wwwAliasUrl()

    @Test
    fun `the www alias of the pinned origin is checked too`() {
        assertEquals("https://www.yokoone.ru", alias)
    }

    @Test
    fun `removal verified on the first round succeeds`() {
        val jar = FakeJar(mutableMapOf(origin to "yoko_mobile_session=a", alias to "crm_user_id=1"))
        val scheduler = FakeScheduler()
        var result: Boolean? = null
        EdgeContextReset.verifyCookieRemoval(jar, scheduler::schedule, { result = it })
        scheduler.runAll()
        assertEquals(true, result)
        assertEquals(1, jar.removeCalls)
        assertTrue(jar.flushes >= 1)
    }

    @Test
    fun `T38a a delayed callback is not trusted - the 2 s fallback verifies by reading`() {
        val jar = FakeJar(mutableMapOf(origin to "yoko_mobile_session=a"))
        jar.callbackDelivered = false
        val scheduler = FakeScheduler()
        var result: Boolean? = null
        EdgeContextReset.verifyCookieRemoval(jar, scheduler::schedule, { result = it })
        scheduler.runAll()
        assertEquals(true, result)
        assertEquals(EdgeContextReset.COOKIE_CALLBACK_TIMEOUT_MS, scheduler.now)
        // The late callback after the decision changes nothing.
        jar.pendingCallbacks.forEach { it() }
        scheduler.runAll()
        assertEquals(1, jar.removeCalls)
    }

    @Test
    fun `T38c removal that never verifies fails after 5 rounds`() {
        val jar = FakeJar(mutableMapOf(origin to "yoko_mobile_session=a", alias to null))
        jar.removalWorks = false
        val scheduler = FakeScheduler()
        var result: Boolean? = null
        EdgeContextReset.verifyCookieRemoval(jar, scheduler::schedule, { result = it })
        scheduler.runAll()
        assertEquals(false, result)
        assertEquals(EdgeContextReset.COOKIE_ROUNDS, jar.removeCalls)
    }

    @Test
    fun `T33 a second automatic reset within 60 s by either clock is skipped`() {
        val last = PushTokenState.LastReset(wallMs = 1_000_000L, elapsedMs = 500_000L, reason = "SESSION_ENDED")
        assertFalse(EdgeContextReset.automaticAllowed(last, 1_000_000L + 59_999, 500_000L + 59_999))
        assertFalse("wall clock alone", EdgeContextReset.automaticAllowed(last, 1_000_000L + 10_000, 500_000L + 3_600_000))
        assertFalse("elapsed alone", EdgeContextReset.automaticAllowed(last, 1_000_000L + 3_600_000, 500_000L + 10_000))
        assertTrue(EdgeContextReset.automaticAllowed(last, 1_000_000L + 60_000, 500_000L + 60_000))
        assertTrue("after a reboot the elapsed delta is negative", EdgeContextReset.automaticAllowed(last, 1_000_000L + 120_000, 10L))
        assertTrue(EdgeContextReset.automaticAllowed(null, 0L, 0L))
        assertTrue(EdgeContextReset.Reason.CONTINUITY_MISMATCH in EdgeContextReset.Reason.AUTOMATIC)
        assertFalse("an explicit switch is never guarded", EdgeContextReset.Reason.OPERATOR_SWITCH in EdgeContextReset.Reason.AUTOMATIC)
    }

    @Test
    fun `T102 step 0 is one commit - display off, rotation pending, both tokens retired, binding and record gone, epoch up`() {
        PushTokenState.rememberToken(context, "newest-token")
        val generation = PushTokenState.startSessionGeneration(context).sessionGeneration
        assertTrue(PushTokenState.applyRegisteredIfCurrent(context, generation, "newest-token"))
        PushTokenState.rememberToken(context, "rotated-token")
        PushTokenState.applyBlockIfCurrent(context, generation, "rotated-token", "MOBILE_SESSION_REVOKED")
        ContinuityGuard.writeRecord(context, "staff.a")
        val epochBefore = PushTokenState.resetEpoch(context)

        val epoch = PushTokenState.beginReset(context, EdgeContextReset.Reason.SESSION_ENDED, 42L, 7L)

        val s = PushTokenState.snapshot(context)
        assertEquals(epochBefore + 1, epoch)
        assertEquals(epoch, s.resetEpoch)
        assertEquals(EdgeContextReset.Reason.SESSION_ENDED, s.resetPending)
        assertFalse(s.displayAllowed)
        assertTrue(s.rotationPending)
        assertNull(s.newestToken)
        assertNull(s.registeredToken)
        assertNull(s.blockedReason)
        assertEquals("session generation is kept", generation, s.sessionGeneration)
        assertTrue(PushTokenState.isRetired(context, "newest-token"))
        assertTrue(PushTokenState.isRetired(context, "rotated-token"))
        assertNull(PushTokenState.continuityRecord(context).body)
        assertEquals(PushTokenState.LastReset(42L, 7L, EdgeContextReset.Reason.SESSION_ENDED), PushTokenState.lastReset(context))

        PushTokenState.completeReset(context)
        assertNull(PushTokenState.resetPending(context))
        assertTrue("rotation is owed independently", PushTokenState.rotationPending(context))
    }

    @Test
    fun `step 0 with K_install unavailable fails closed - every later token needs a confirmed delete`() {
        PushTokenState.rememberToken(context, "newest-token")
        PushTokenState.installKeyAvailable(context)
        keys.failing = true
        PushTokenState.beginReset(context, EdgeContextReset.Reason.OPERATOR_SWITCH, 1L, 1L)
        keys.failing = false
        assertTrue(PushTokenState.snapshot(context).installKeyRecoveryPending)
        PushTokenState.completeReset(context)
        val epoch = PushTokenState.resetEpoch(context)
        assertEquals(
            PushTokenState.CommitResult.Rejected("key-recovery-pending"),
            PushTokenState.commitToken(context, epoch, PushTokenState.CommitKind.REFRESH, "any-token", deleteSucceeded = false),
        )
    }

    @Test
    fun `the retired set is a FIFO of the last 8`() {
        repeat(10) { index ->
            PushTokenState.rememberToken(context, "token-$index")
            PushTokenState.beginReset(context, EdgeContextReset.Reason.OPERATOR_SWITCH, index.toLong(), index.toLong())
            PushTokenState.completeReset(context)
        }
        assertEquals(PushTokenState.RETIRED_CAPACITY, PushTokenState.retiredCount(context))
        assertTrue(PushTokenState.isRetired(context, "token-9"))
        assertFalse(PushTokenState.isRetired(context, "token-0"))
    }

    @Test
    fun `shortcut resets are limited to 3 per 10 minutes`() {
        val start = 10_000_000L
        assertTrue(PushTokenState.admitShortcutReset(context, start))
        assertTrue(PushTokenState.admitShortcutReset(context, start + 1_000))
        assertTrue(PushTokenState.admitShortcutReset(context, start + 2_000))
        assertFalse(PushTokenState.admitShortcutReset(context, start + 3_000))
        assertTrue(PushTokenState.admitShortcutReset(context, start + 10 * 60 * 1000L + 1))
    }

    @Test
    fun `O-3 the rotation notice comes once after 24 h pending`() {
        PushTokenState.beginReset(context, EdgeContextReset.Reason.OPERATOR_SWITCH, 1_000L, 1L)
        assertFalse("not while the reset is pending", PushTokenState.takeRotationNotice(context, 1_000L + 25 * 3_600_000L))
        PushTokenState.completeReset(context)
        assertFalse(PushTokenState.takeRotationNotice(context, 1_000L + 3_600_000L))
        assertTrue(PushTokenState.takeRotationNotice(context, 1_000L + 25 * 3_600_000L))
        assertFalse(PushTokenState.takeRotationNotice(context, 1_000L + 26 * 3_600_000L))
    }

    @Test
    fun `reasons from an Intent are reduced to known names for a log line`() {
        assertEquals("OPERATOR_SWITCH", EdgeContextReset.Reason.sanitize("OPERATOR_SWITCH"))
        assertEquals("unknown", EdgeContextReset.Reason.sanitize("anything<else>"))
        assertEquals("unknown", EdgeContextReset.Reason.sanitize(null))
    }
}
