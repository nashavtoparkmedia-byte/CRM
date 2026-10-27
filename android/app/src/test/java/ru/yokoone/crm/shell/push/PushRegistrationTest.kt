package ru.yokoone.crm.shell.push

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import ru.yokoone.crm.shell.CrmOrigin
import ru.yokoone.crm.shell.EdgeTestSupport
import java.util.Collections

/**
 * When a page settling on screen is news, and when it is just navigation.
 *
 * The scenario that drove this design is the last one: an operator logs out and
 * back in on the same handset, Firebase has no reason to rotate anything, and
 * the server has revoked the device in between. Keying registration on the
 * token alone leaves that operator silently unregistered for as long as the
 * token lives, which can be for ever.
 *
 * Since edge design R5.1 a provider callback is only a signal: [deliver] puts
 * the token in a fake provider and signals, and the token actor reads and
 * commits it, exactly as onNewToken does in production.
 */
@RunWith(RobolectricTestRunner::class)
class PushRegistrationTest {

    private val context: Context get() = ApplicationProvider.getApplicationContext()

    private val scheduled: MutableList<Pair<Long, String>> = Collections.synchronizedList(mutableListOf())
    private val provider = EdgeTestSupport.FakeProvider()
    private val realScheduler = PushRegistration.scheduler

    private val sessionCookie = "${PushRegistrar.SESSION_COOKIE_NAME}=s3ss10nvalue; yoko_ui_identity=op_1"
    private val messengerUrl = "${CrmOrigin.ORIGIN}/messages"
    private val conversationUrl = "${CrmOrigin.ORIGIN}/messages?id=chat_1&channel=tg"
    private val loginUrl = "${CrmOrigin.ORIGIN}${CrmOrigin.LOGIN_PATH}?next=%2Fmessages"

    /** The provider now holds [token], and says so (R5.1 §5.7.2: a signal, the actor reads). */
    private fun deliver(token: String) {
        provider.current = token
        PushRegistration.onNewToken(context, token)
        EdgeTestSupport.idle()
    }

    @Before
    fun isolate() {
        EdgeTestSupport.reset(context)
        EdgeTestSupport.useProvider(provider)
        scheduled.clear()
        PushRegistration.forgetProcessObservation()
        PushRegistration.scheduler = PushRegistration.Scheduler { _, generation, token ->
            scheduled += generation to token
        }
    }

    @After
    fun restore() {
        EdgeTestSupport.idle()
        EdgeTestSupport.useProvider(null)
        PushRegistration.scheduler = realScheduler
        PushRegistration.forgetProcessObservation()
    }

    @Test
    fun `an authenticated page is one on the pinned origin, past the login screen, with a session`() {
        assertTrue(PushRegistration.isAuthenticatedPage(messengerUrl, sessionCookie))
        assertFalse("the login screen is never authenticated", PushRegistration.isAuthenticatedPage(loginUrl, sessionCookie))
        assertFalse("no session cookie, no session", PushRegistration.isAuthenticatedPage(messengerUrl, "yoko_ui_identity=op_1"))
        assertFalse(PushRegistration.isAuthenticatedPage(messengerUrl, null))
        assertFalse("off origin", PushRegistration.isAuthenticatedPage("https://evil.example/messages", sessionCookie))
        assertFalse(PushRegistration.isAuthenticatedPage(null, sessionCookie))
    }

    @Test
    fun `the first authenticated page of a process registers exactly once`() {
        deliver("T1")
        assertTrue("no session yet, nothing to ask", scheduled.isEmpty())

        assertTrue(PushRegistration.onPageSettled(context, messengerUrl, sessionCookie))

        assertEquals(listOf(1L to "T1"), scheduled)
    }

    @Test
    fun `navigating between authenticated pages asks for nothing`() {
        deliver("T1")
        PushRegistration.onPageSettled(context, messengerUrl, sessionCookie)
        scheduled.clear()

        assertFalse(PushRegistration.onPageSettled(context, conversationUrl, sessionCookie))
        assertFalse(PushRegistration.onPageSettled(context, messengerUrl, sessionCookie))

        assertTrue("ordinary navigation must not enqueue", scheduled.isEmpty())
    }

    @Test
    fun `a login is a new generation even when the token has not changed`() {
        deliver("T1")
        PushRegistration.onPageSettled(context, messengerUrl, sessionCookie)
        val firstGeneration = PushTokenState.snapshot(context).sessionGeneration
        PushTokenState.applyRegisteredIfCurrent(context, firstGeneration, "T1")
        assertTrue(PushTokenState.snapshot(context).isRegistered)
        scheduled.clear()

        // Logout: the CRM lands the shell back on the mobile login screen and
        // the session cookie is gone.
        assertFalse(PushRegistration.onPageSettled(context, loginUrl, null))
        assertTrue("logging back in must be a transition", PushRegistration.onPageSettled(context, messengerUrl, sessionCookie))

        assertEquals(listOf(firstGeneration + 1 to "T1"), scheduled)
    }

    @Test
    fun `a session that expires mid-use is noticed through the login screen`() {
        deliver("T1")
        PushRegistration.onPageSettled(context, messengerUrl, sessionCookie)
        PushTokenState.applyRegisteredIfCurrent(context, PushTokenState.snapshot(context).sessionGeneration, "T1")
        scheduled.clear()

        // The 401 handler reloads the start URL, the CRM answers with the login
        // screen, and the operator signs in again.
        PushRegistration.onPageSettled(context, loginUrl, sessionCookie)
        PushRegistration.onPageSettled(context, conversationUrl, sessionCookie)

        assertEquals(1, scheduled.size)
    }

    @Test
    fun `a token arriving after the session is registered under it`() {
        assertTrue(PushRegistration.onPageSettled(context, messengerUrl, sessionCookie))
        assertTrue("no token yet", scheduled.isEmpty())

        deliver("T1")

        assertEquals(listOf(1L to "T1"), scheduled)
    }

    @Test
    fun `a rotated token is registered under the session already in place`() {
        deliver("T1")
        PushRegistration.onPageSettled(context, messengerUrl, sessionCookie)
        PushTokenState.applyRegisteredIfCurrent(context, 1L, "T1")
        scheduled.clear()

        deliver("T2")

        assertEquals(listOf(1L to "T2"), scheduled)
    }

    @Test
    fun `the same token again asks for nothing`() {
        deliver("T1")
        PushRegistration.onPageSettled(context, messengerUrl, sessionCookie)
        PushTokenState.applyRegisteredIfCurrent(context, 1L, "T1")
        scheduled.clear()

        deliver("T1")

        assertTrue(scheduled.isEmpty())
    }

    @Test
    fun `a refused device id is not retried until a new session`() {
        deliver("T1")
        PushRegistration.onPageSettled(context, messengerUrl, sessionCookie)
        PushTokenState.applyBlockIfCurrent(context, 1L, "T1", "PUSH_DEVICE_ID_NOT_STABLE")
        scheduled.clear()

        // Every page view in this session, and a rotated token too.
        PushRegistration.onPageSettled(context, conversationUrl, sessionCookie)
        deliver("T2")
        assertTrue("a block must not turn into a request per page", scheduled.isEmpty())

        PushRegistration.onPageSettled(context, loginUrl, null)
        PushRegistration.onPageSettled(context, messengerUrl, sessionCookie)

        assertEquals(listOf(2L to "T2"), scheduled)
    }

    @Test
    fun `a token conflict is retried by a different token without waiting for a login`() {
        deliver("T1")
        PushRegistration.onPageSettled(context, messengerUrl, sessionCookie)
        PushTokenState.applyBlockIfCurrent(context, 1L, "T1", PushTokenState.TOKEN_SCOPED_REASON)
        scheduled.clear()

        deliver("T2")

        assertEquals(listOf(1L to "T2"), scheduled)
    }

    @Test
    fun `a provider callback carries no value - the actor commits what the provider holds`() {
        provider.current = "T-provider"
        PushRegistration.onNewToken(context, "T-callback")
        EdgeTestSupport.idle()

        assertEquals("T-provider", PushTokenState.snapshot(context).newestToken)
    }

    @Test
    fun `T9 an edge acceptance asks for registration only when one is needed`() {
        deliver("T1")
        PushRegistration.onPageSettled(context, messengerUrl, sessionCookie)
        scheduled.clear()

        PushRegistration.onEdgeReady(context)
        PushRegistration.onEdgeReady(context)
        // Two asks for the same pair; unique work REPLACE keeps one attempt.
        assertEquals(listOf(1L to "T1", 1L to "T1"), scheduled)

        PushTokenState.applyRegisteredIfCurrent(context, 1L, "T1")
        scheduled.clear()
        PushRegistration.onEdgeReady(context)
        assertTrue("registered: nothing to ask", scheduled.isEmpty())
    }
}
