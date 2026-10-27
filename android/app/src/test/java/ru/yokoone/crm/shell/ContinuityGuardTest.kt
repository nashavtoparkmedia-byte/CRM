package ru.yokoone.crm.shell

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import ru.yokoone.crm.shell.ContinuityGuard.EdgeGate
import ru.yokoone.crm.shell.ContinuityGuard.Precheck
import ru.yokoone.crm.shell.ContinuityGuard.ProbeOutcome
import ru.yokoone.crm.shell.push.PushTokenState

/**
 * The continuity barrier (R5.1 §5.8.3) and its record storage: T75–T78, T85,
 * T93, T99, T119 and the IMPL-1 cases.
 */
@RunWith(RobolectricTestRunner::class)
class ContinuityGuardTest {

    private val context: Context get() = ApplicationProvider.getApplicationContext()
    private lateinit var keys: EdgeTestSupport.MemoryKeys

    @Before
    fun setUp() {
        keys = EdgeTestSupport.reset(context)
    }

    private fun precheck(
        cookie: Boolean = true,
        gate: EdgeGate = EdgeGate.PRESENT,
        installKey: Boolean = true,
    ): Precheck {
        val (stored, verification) = ContinuityGuard.verifyStored(context)
        return ContinuityGuard.precheck(cookie, stored, verification, installKey, gate, ContinuityGuard.noEdgeFingerprint(context))
    }

    @Test
    fun `no cookie and no record means no barrier`() {
        assertEquals(Precheck.None, precheck(cookie = false))
    }

    @Test
    fun `a valid edge record with the gate present asks for the probe`() {
        assertEquals(ContinuityGuard.WriteResult.WRITTEN, ContinuityGuard.writeRecord(context, "staff.a"))
        val decision = precheck()
        assertTrue("got $decision", decision is Precheck.Probe)
        assertEquals(ContinuityGuard.fingerprintOf(context, "staff.a"), (decision as Precheck.Probe).recordFp)
    }

    @Test
    fun `T76 a session cookie without a record is a mismatch`() {
        assertTrue(precheck() is Precheck.Mismatch)
    }

    @Test
    fun `T77 a corrupted record or a missing key is a mismatch`() {
        ContinuityGuard.writeRecord(context, "staff.a")
        keys.keys.keys.filter { it.startsWith(ShellKeys.CONTEXT_ALIAS_PREFIX) }.forEach { keys.keys.remove(it) }
        assertEquals(Precheck.Mismatch("record-key"), precheck())
    }

    @Test
    fun `T78 an edge record with the gate unknown or absent is a mismatch`() {
        ContinuityGuard.writeRecord(context, "staff.a")
        assertTrue(precheck(gate = EdgeGate.UNKNOWN) is Precheck.Mismatch)
        assertTrue(precheck(gate = EdgeGate.ABSENT) is Precheck.Mismatch)
    }

    @Test
    fun `T93 with K_install unavailable continuity is never confirmed`() {
        ContinuityGuard.writeRecord(context, "staff.a")
        assertEquals(Precheck.Mismatch("install-key"), precheck(installKey = false))
        val fp = ContinuityGuard.fingerprintOf(context, "staff.a")!!
        assertFalse(ContinuityGuard.decide("staff.a", "staff.a", fp, installKeyAvailable = false) { ContinuityGuard.fingerprintOf(context, it) })
    }

    @Test
    fun `IMPL-1 a gate-less session continues only while the gate is still absent`() {
        assertEquals(ContinuityGuard.WriteResult.WRITTEN, ContinuityGuard.writeRecord(context, null))
        assertEquals(Precheck.ConfirmedNoEdge, precheck(gate = EdgeGate.ABSENT))
        assertEquals(Precheck.Mismatch("gate-appeared"), precheck(gate = EdgeGate.PRESENT))
        assertEquals(Precheck.Mismatch("gate-appeared"), precheck(gate = EdgeGate.UNKNOWN))
    }

    @Test
    fun `T98 a reset deletes the record and a restored copy is a replay`() {
        ContinuityGuard.writeRecord(context, "staff.a")
        val before = PushTokenState.continuityRecord(context)
        PushTokenState.beginReset(context, EdgeContextReset.Reason.OPERATOR_SWITCH, 1L, 1L)
        assertEquals(null, PushTokenState.continuityRecord(context).body)
        // Put the old record back as an attacker with file access would.
        synchronized(PushTokenState.LOCK) {
            PushTokenState.storeContinuityRecordLocked(context, before.keyAlias!!, before.body!!, before.mac!!)
        }
        assertEquals(Precheck.Mismatch("record-epoch"), precheck())
    }

    @Test
    fun `T75 T82 the probe decides on the accepted username only`() {
        ContinuityGuard.writeRecord(context, "staff.a")
        val fp = ContinuityGuard.fingerprintOf(context, "staff.a")!!
        val fpOf: (String) -> String? = { ContinuityGuard.fingerprintOf(context, it) }
        assertTrue(ContinuityGuard.decide("staff.a", "staff.a", fp, true, fpOf))
        assertFalse("different edge principal", ContinuityGuard.decide("staff.b", "staff.b", fp, true, fpOf))
        assertFalse("case matters", ContinuityGuard.decide("Staff.A", "Staff.A", fp, true, fpOf))
    }

    @Test
    fun `T85 accepted username different from the pinned one is a mismatch`() {
        ContinuityGuard.writeRecord(context, "staff.a")
        val fp = ContinuityGuard.fingerprintOf(context, "staff.a")!!
        assertFalse(ContinuityGuard.decide("staff.a", "staff.b", fp, true) { ContinuityGuard.fingerprintOf(context, it) })
        assertFalse(ContinuityGuard.decide(null, "staff.a", fp, true) { ContinuityGuard.fingerprintOf(context, it) })
    }

    @Test
    fun `T99 an existing record is never overwritten with another fingerprint`() {
        assertEquals(ContinuityGuard.WriteResult.WRITTEN, ContinuityGuard.writeRecord(context, "staff.a"))
        val before = PushTokenState.continuityRecord(context)
        assertEquals(ContinuityGuard.WriteResult.MISMATCH, ContinuityGuard.writeRecord(context, "staff.b"))
        assertEquals(ContinuityGuard.WriteResult.MISMATCH, ContinuityGuard.writeRecord(context, null))
        assertEquals(before, PushTokenState.continuityRecord(context))
        assertEquals(ContinuityGuard.WriteResult.SAME, ContinuityGuard.writeRecord(context, "staff.a"))
    }

    @Test
    fun `a broken K_ctx makes the write fail closed`() {
        keys.failing = true
        assertEquals(ContinuityGuard.WriteResult.KEY_UNAVAILABLE, ContinuityGuard.writeRecord(context, "staff.a"))
        keys.failing = false
        assertTrue("a cookie without a record is then a mismatch", precheck() is Precheck.Mismatch)
    }

    @Test
    fun `T119 probe outcomes - any HTTP answer after a proceed is acceptance, transport failures decide nothing`() {
        for (status in listOf(200, 302, 303, 404, 500, 502)) {
            assertEquals("status $status", ProbeOutcome.ACCEPTED, ContinuityGuard.classifyProbe(status, null, proceeded = true, transportFailed = false))
        }
        assertEquals(ProbeOutcome.REFUSED, ContinuityGuard.classifyProbe(401, "Basic realm=\"YOKO CRM\"", proceeded = true, transportFailed = false))
        assertEquals(ProbeOutcome.REFUSED, ContinuityGuard.classifyProbe(401, "Basic realm=\"YOKO CRM\"", proceeded = false, transportFailed = false))
        // Security R5.1-1: an answer without a proceed() verified nothing.
        assertEquals(ProbeOutcome.UNVERIFIED, ContinuityGuard.classifyProbe(200, null, proceeded = false, transportFailed = false))
        assertEquals(ProbeOutcome.UNVERIFIED, ContinuityGuard.classifyProbe(401, null, proceeded = false, transportFailed = false))
        // Network error, TLS error, timeout.
        assertEquals(ProbeOutcome.UNDECIDED, ContinuityGuard.classifyProbe(null, null, proceeded = true, transportFailed = true))
        assertEquals(ProbeOutcome.UNDECIDED, ContinuityGuard.classifyProbe(200, null, proceeded = true, transportFailed = true))
    }

    @Test
    fun `registration is allowed only once continuity is decided in this process`() {
        ContinuityGuard.state = ContinuityGuard.State.UNDECIDED
        assertFalse(ContinuityGuard.allowsRegistration)
        ContinuityGuard.state = ContinuityGuard.State.PENDING
        assertFalse(ContinuityGuard.allowsRegistration)
        ContinuityGuard.state = ContinuityGuard.State.MISMATCH
        assertFalse(ContinuityGuard.allowsRegistration)
        ContinuityGuard.state = ContinuityGuard.State.CONFIRMED
        assertTrue(ContinuityGuard.allowsRegistration)
        ContinuityGuard.state = ContinuityGuard.State.NONE
        assertTrue(ContinuityGuard.allowsRegistration)
    }
}
