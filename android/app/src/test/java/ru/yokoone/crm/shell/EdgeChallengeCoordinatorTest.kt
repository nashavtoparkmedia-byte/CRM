package ru.yokoone.crm.shell

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import ru.yokoone.crm.shell.EdgeChallengeCoordinator.EdgeState

/**
 * Challenge rules A–F (R5.1 §3.3) with fake handlers, a fake UI and a fake
 * clock: what is answered, queued, refused, or turned into a reset.
 */
@RunWith(RobolectricTestRunner::class)
class EdgeChallengeCoordinatorTest {

    private var now = 5_000_000L

    private class FakeChallenge(
        override val host: String? = EdgeAuthPolicy.PINNED_HOST,
        override val realm: String? = EdgeAuthPolicy.EDGE_REALM,
        var stored: Boolean = true,
    ) : EdgeChallengeCoordinator.Challenge {
        val proceeded = mutableListOf<Pair<String, String>>()
        var cancelled = false
        override fun useStoredCredential(): Boolean = stored
        override fun proceed(username: String, password: String) {
            proceeded += username to password
        }
        override fun cancel() {
            cancelled = true
        }
    }

    private inner class FakeUi : EdgeChallengeCoordinator.Ui {
        var preconditions = true
        var mayAnswer = true
        val dialogs = mutableListOf<Boolean>()
        var closed = 0
        val stops = mutableListOf<EdgeState>()
        var unavailable = 0
        var proceededCount = 0
        var credentialReady = 0
        val resets = mutableListOf<String>()
        var gateSeen = 0
        override fun preconditionsMet() = preconditions
        override fun onStaffGateSeen() { gateSeen += 1 }
        override fun mayAnswerStaffChallenge() = mayAnswer
        override fun openDialog(wrongPassword: Boolean) { dialogs += wrongPassword }
        override fun closeDialog() { closed += 1 }
        override fun stopAfterDecline(state: EdgeState) { stops += state }
        override fun onUnavailable() { unavailable += 1 }
        override fun onProceeded() { proceededCount += 1 }
        override fun onCredentialReady() { credentialReady += 1 }
        override fun requestReset(reason: String) { resets += reason }
        override fun diagnostic(line: String) = Unit
    }

    private lateinit var ui: FakeUi
    private lateinit var coordinator: EdgeChallengeCoordinator

    @Before
    fun setUp() {
        EdgeCredentialHolder.resetForTest()
        EdgeChallengeCoordinator.ProcessFacts.resetForTest()
        EdgeCredentialHolder.clock = { now }
        ui = FakeUi()
        coordinator = EdgeChallengeCoordinator(ui)
    }

    @After
    fun tearDown() {
        EdgeCredentialHolder.resetForTest()
    }

    private fun submit(user: String = "staff.a", password: String = "right") =
        coordinator.onDialogSubmit(user, password.toCharArray())

    /** Prompt, submit, and let rule G accept. */
    private fun authenticate(user: String = "staff.a"): FakeChallenge {
        val first = FakeChallenge()
        coordinator.onChallenge(first)
        submit(user)
        assertTrue(coordinator.markAuthenticated())
        return first
    }

    @Test
    fun `rule A - foreign host, foreign realm and unmet preconditions are cancelled without a dialog`() {
        val foreign = listOf(
            FakeChallenge(host = "www.yokoone.ru"),
            FakeChallenge(host = "proxy.local"),
            FakeChallenge(realm = "YOKO compensation"),
            FakeChallenge(realm = "YOKO Cash"),
            FakeChallenge(realm = "other"),
        )
        foreign.forEach { coordinator.onChallenge(it) }
        assertTrue(foreign.all { it.cancelled && it.proceeded.isEmpty() })
        assertTrue(ui.dialogs.isEmpty())

        ui.preconditions = false
        val gated = FakeChallenge()
        coordinator.onChallenge(gated)
        assertTrue(gated.cancelled)
        assertEquals(EdgeState.UNAVAILABLE, coordinator.state)
        assertEquals(1, ui.unavailable)
        assertTrue(ui.dialogs.isEmpty())
    }

    @Test
    fun `T44 T84 parallel challenges open one dialog and are all answered with one username`() {
        val challenges = List(4) { FakeChallenge() }
        challenges.forEach { coordinator.onChallenge(it) }
        assertEquals("exactly one dialog", listOf(false), ui.dialogs)
        assertEquals(EdgeState.PROMPTING, coordinator.state)
        assertEquals(4, coordinator.queued)

        submit()

        assertTrue(challenges.all { it.proceeded == listOf("staff.a" to "right") })
        assertEquals("staff.a", EdgeCredentialHolder.pinnedUsername)
        assertEquals(EdgeState.AUTHENTICATING, coordinator.state)
    }

    @Test
    fun `rule E answers from the holder while the request was not rejected, up to 8 times`() {
        authenticate()
        repeat(EdgeAuthPolicy.MAX_AUTO_ANSWERS_PER_NAVIGATION) {
            val next = FakeChallenge()
            coordinator.onChallenge(next)
            assertEquals(1, next.proceeded.size)
        }
        // The ninth is the bounded fallback: a refusal of an accepted credential.
        val ninth = FakeChallenge()
        coordinator.onChallenge(ninth)
        assertTrue(ninth.cancelled)
        assertEquals(listOf(EdgeContextReset.Reason.EDGE_CREDENTIAL_REFUSED), ui.resets)
    }

    @Test
    fun `T34 a rejected accepted credential resets EDGE_CREDENTIAL_REFUSED`() {
        authenticate()
        val rejected = FakeChallenge(stored = false)
        coordinator.onChallenge(rejected)
        assertTrue(rejected.cancelled)
        assertTrue(rejected.proceeded.isEmpty())
        assertEquals(listOf(EdgeContextReset.Reason.EDGE_CREDENTIAL_REFUSED), ui.resets)
        assertFalse(EdgeCredentialHolder.isPresent)
    }

    @Test
    fun `T12 wrong passwords re-prompt with the username pinned, then stop EXHAUSTED`() {
        coordinator.onChallenge(FakeChallenge())
        submit("staff.a", "wrong1")
        coordinator.onChallenge(FakeChallenge(stored = false))
        assertEquals(listOf(false, true), ui.dialogs)
        submit("someone.else", "wrong2")
        assertEquals("the username cannot change between prompts", "staff.a", EdgeCredentialHolder.currentUsername())
        coordinator.onChallenge(FakeChallenge(stored = false))
        submit("staff.a", "wrong3")
        coordinator.onChallenge(FakeChallenge(stored = false))

        assertEquals(EdgeState.EXHAUSTED, coordinator.state)
        assertEquals(listOf(EdgeState.EXHAUSTED), ui.stops)
        assertTrue("a wrong password typed now is not a reset", ui.resets.isEmpty())
    }

    @Test
    fun `T13 rule F and B - after a decline, later challenges are cancelled silently`() {
        val first = FakeChallenge()
        coordinator.onChallenge(first)
        coordinator.onDialogCancel()
        assertTrue(first.cancelled)
        assertEquals(EdgeState.DECLINED, coordinator.state)
        assertEquals(listOf(EdgeState.DECLINED), ui.stops)

        val poll = FakeChallenge()
        coordinator.onChallenge(poll)
        assertTrue(poll.cancelled)
        assertEquals("no new dialog from page polling", 1, ui.dialogs.size)
    }

    @Test
    fun `T86 a decline then Войти keeps the pinned username`() {
        coordinator.onChallenge(FakeChallenge())
        submit("staff.a", "wrong")
        coordinator.onChallenge(FakeChallenge(stored = false))
        coordinator.onDialogCancel()
        coordinator.resumeAfterStop()
        assertEquals(EdgeState.REQUIRED, coordinator.state)

        coordinator.onChallenge(FakeChallenge())
        submit("staff.b", "right")
        assertEquals("staff.a", EdgeCredentialHolder.currentUsername())
    }

    @Test
    fun `T36 T92 an accepted credential past 12 h resets EDGE_MAX_AGE, before it a repeat is answered`() {
        authenticate()
        now += 60_000
        val repeat = FakeChallenge()
        coordinator.onChallenge(repeat)
        assertEquals("answered without a prompt", 1, repeat.proceeded.size)
        assertEquals(1, ui.dialogs.size)

        now += EdgeAuthPolicy.EDGE_MAX_AGE_MS
        val late = FakeChallenge()
        coordinator.onChallenge(late)
        assertTrue(late.cancelled)
        assertTrue(late.proceeded.isEmpty())
        assertEquals(listOf(EdgeContextReset.Reason.EDGE_MAX_AGE), ui.resets)
    }

    @Test
    fun `T90 an unaccepted credential expired at this tick prompts instead of proceeding`() {
        coordinator.onChallenge(FakeChallenge())
        submit()
        now += EdgeAuthPolicy.UNACCEPTED_MAX_MS
        val next = FakeChallenge()
        coordinator.onChallenge(next)
        assertTrue(next.proceeded.isEmpty())
        assertEquals(2, ui.dialogs.size)
        assertEquals(EdgeState.PROMPTING, coordinator.state)
    }

    @Test
    fun `T40 onPause with the dialog open closes it, cancels the queue and goes REQUIRED`() {
        val a = FakeChallenge()
        val b = FakeChallenge()
        coordinator.onChallenge(a)
        coordinator.onChallenge(b)
        assertTrue(coordinator.onPause())
        assertEquals(1, ui.closed)
        assertTrue(a.cancelled && b.cancelled)
        assertEquals(EdgeState.REQUIRED, coordinator.state)
        assertFalse("no reopen without the operator", coordinator.onPause())
    }

    @Test
    fun `T76a onStop clears an unaccepted credential, its queue and never auto-answers with it`() {
        coordinator.onChallenge(FakeChallenge())
        submit()
        assertTrue(coordinator.onStop())
        assertFalse(EdgeCredentialHolder.isPresent)
        assertEquals(EdgeState.REQUIRED, coordinator.state)

        val later = FakeChallenge()
        coordinator.onChallenge(later)
        assertTrue(later.proceeded.isEmpty())
        assertEquals(2, ui.dialogs.size)
    }

    @Test
    fun `T88 the 5 minute timer clears an unaccepted credential`() {
        coordinator.onChallenge(FakeChallenge())
        submit()
        now += EdgeAuthPolicy.UNACCEPTED_MAX_MS
        assertTrue(coordinator.onUnacceptedExpiry())
        assertFalse(EdgeCredentialHolder.isPresent)
    }

    @Test
    fun `IMPL-1 a staff challenge in a gate-less session resets before any credential is sent`() {
        ui.mayAnswer = false
        EdgeCredentialHolder.set("staff.a", "right".toCharArray(), now)
        val challenge = FakeChallenge()
        coordinator.onChallenge(challenge)
        assertTrue(challenge.cancelled)
        assertTrue(challenge.proceeded.isEmpty())
        assertEquals(listOf(EdgeContextReset.Reason.CONTINUITY_MISMATCH), ui.resets)
        assertEquals("the gate is remembered", 1, ui.gateSeen)
    }

    @Test
    fun `a native-lane refusal of the accepted credential resets at the next challenge`() {
        authenticate()
        EdgeCredentialHolder.refusedByRegistrar = true
        val next = FakeChallenge()
        coordinator.onChallenge(next)
        assertTrue(next.cancelled)
        assertEquals(listOf(EdgeContextReset.Reason.EDGE_CREDENTIAL_REFUSED), ui.resets)
    }

    @Test
    fun `the bootstrap prompt fills the holder without a challenge and says so`() {
        coordinator.promptPreemptively()
        assertEquals(listOf(false), ui.dialogs)
        submit()
        assertEquals(1, ui.credentialReady)
        assertTrue(EdgeCredentialHolder.isPresent)
        // The probe's challenge is then answered from the holder and pins the username.
        val probe = FakeChallenge()
        coordinator.onChallenge(probe)
        assertEquals(listOf("staff.a" to "right"), probe.proceeded)
        assertEquals("staff.a", EdgeCredentialHolder.pinnedUsername)
        assertTrue(coordinator.markAuthenticated())
        assertTrue(coordinator.everAuthenticated)
    }

    @Test
    fun `reset step 1 clears the dialog, the queue and the holder`() {
        val queued = FakeChallenge()
        coordinator.onChallenge(queued)
        coordinator.clearForReset()
        assertTrue(queued.cancelled)
        assertEquals(1, ui.closed)
        assertEquals(EdgeState.UNKNOWN, coordinator.state)
        assertFalse(EdgeCredentialHolder.isPresent)
    }
}
