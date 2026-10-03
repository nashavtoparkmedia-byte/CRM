package ru.yokoone.crm.shell.push

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/**
 * The derived answers this whole milestone turns on: is the device registered,
 * and may it ask again.
 *
 * The block cases are the ones with teeth. A refusal that keeps applying when
 * it should not means a device that never registers; a refusal that stops
 * applying when it should not means a request repeated on every page view.
 */
@RunWith(RobolectricTestRunner::class)
class PushTokenStateTest {

    private val context: Context get() = ApplicationProvider.getApplicationContext()

    @Before
    fun clearState() {
        context.getSharedPreferences(PushTokenState.PREFS_NAME, Context.MODE_PRIVATE)
            .edit().clear().commit()
    }

    private fun authenticate(): Long = PushTokenState.startSessionGeneration(context).sessionGeneration

    @Test
    fun `a token with no session is not yet anything to register`() {
        val state = PushTokenState.rememberToken(context, "T1")
        assertFalse(state.isRegistered)
        assertFalse(state.needsRegistration)
    }

    @Test
    fun `a token under an authenticated session wants registering, then is registered`() {
        PushTokenState.rememberToken(context, "T1")
        val generation = authenticate()

        assertTrue(PushTokenState.snapshot(context).needsRegistration)
        assertTrue(PushTokenState.applyRegisteredIfCurrent(context, generation, "T1"))

        val state = PushTokenState.snapshot(context)
        assertTrue(state.isRegistered)
        assertFalse(state.needsRegistration)
    }

    @Test
    fun `a new session generation makes an existing registration stale`() {
        PushTokenState.rememberToken(context, "T1")
        PushTokenState.applyRegisteredIfCurrent(context, authenticate(), "T1")
        assertTrue(PushTokenState.snapshot(context).isRegistered)

        // Logout, then a new login on the same installation with the same token.
        authenticate()

        val state = PushTokenState.snapshot(context)
        assertFalse("the same token under a new session is not registered", state.isRegistered)
        assertTrue("and must be registered again", state.needsRegistration)
        assertEquals("T1", state.newestToken)
    }

    @Test
    fun `a session refusal is not bypassed by a new token in the same generation`() {
        PushTokenState.rememberToken(context, "T1")
        val generation = authenticate()
        PushTokenState.applyBlockIfCurrent(context, generation, "T1", "MOBILE_SESSION_REVOKED")
        assertTrue(PushTokenState.snapshot(context).isBlocked)

        PushTokenState.rememberToken(context, "T2")

        val state = PushTokenState.snapshot(context)
        assertTrue("a new token cannot cure a revoked session", state.isBlocked)
        assertFalse(state.needsRegistration)
    }

    @Test
    fun `an unstable device id is not bypassed by a new token either`() {
        PushTokenState.rememberToken(context, "T1")
        PushTokenState.applyBlockIfCurrent(context, authenticate(), "T1", "PUSH_DEVICE_ID_NOT_STABLE")
        PushTokenState.rememberToken(context, "T2")

        assertTrue(PushTokenState.snapshot(context).isBlocked)
    }

    @Test
    fun `a token bound to another device is retried with a genuinely different token`() {
        PushTokenState.rememberToken(context, "T1")
        val generation = authenticate()
        PushTokenState.applyBlockIfCurrent(context, generation, "T1", PushTokenState.TOKEN_SCOPED_REASON)
        assertTrue(PushTokenState.snapshot(context).isBlocked)

        PushTokenState.rememberToken(context, "T2")

        val state = PushTokenState.snapshot(context)
        assertFalse("the conflict belonged to the old token", state.isBlocked)
        assertTrue(state.needsRegistration)
    }

    @Test
    fun `the same token again does not reopen a conflict`() {
        PushTokenState.rememberToken(context, "T1")
        PushTokenState.applyBlockIfCurrent(context, authenticate(), "T1", PushTokenState.TOKEN_SCOPED_REASON)

        PushTokenState.rememberToken(context, "T1")

        assertTrue(PushTokenState.snapshot(context).isBlocked)
    }

    @Test
    fun `a new authenticated generation retries every kind of refusal`() {
        for (reason in PushTokenState.GENERATION_SCOPED_REASONS + PushTokenState.TOKEN_SCOPED_REASON) {
            clearState()
            PushTokenState.rememberToken(context, "T1")
            PushTokenState.applyBlockIfCurrent(context, authenticate(), "T1", reason)
            assertTrue("$reason should block", PushTokenState.snapshot(context).isBlocked)

            authenticate()

            val state = PushTokenState.snapshot(context)
            assertFalse("$reason should not survive a new session", state.isBlocked)
            assertTrue("$reason should be retried with the same token", state.needsRegistration)
        }
    }

    @Test
    fun `currency is the pair, not either half`() {
        PushTokenState.rememberToken(context, "T1")
        val generation = authenticate()
        val state = PushTokenState.snapshot(context)

        assertTrue(state.isCurrent(generation, "T1"))
        assertFalse(state.isCurrent(generation, "T2"))
        assertFalse(state.isCurrent(generation + 1, "T1"))
    }
}
