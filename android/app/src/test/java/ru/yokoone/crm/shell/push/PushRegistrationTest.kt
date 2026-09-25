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

/**
 * When a page settling on screen is news, and when it is just navigation.
 *
 * The scenario that drove this design is the last one: an operator logs out and
 * back in on the same handset, Firebase has no reason to rotate anything, and
 * the server has revoked the device in between. Keying registration on the
 * token alone leaves that operator silently unregistered for as long as the
 * token lives, which can be for ever.
 */
@RunWith(RobolectricTestRunner::class)
class PushRegistrationTest {

    private val context: Context get() = ApplicationProvider.getApplicationContext()

    private val scheduled = mutableListOf<Pair<Long, String>>()
    private val realScheduler = PushRegistration.scheduler

    private val sessionCookie = "${PushRegistrar.SESSION_COOKIE_NAME}=s3ss10nvalue; yoko_ui_identity=op_1"
    private val messengerUrl = "${CrmOrigin.ORIGIN}/messages"
    private val conversationUrl = "${CrmOrigin.ORIGIN}/messages?id=chat_1&channel=tg"
    private val loginUrl = "${CrmOrigin.ORIGIN}${CrmOrigin.LOGIN_PATH}?next=%2Fmessages"

    @Before
    fun isolate() {
        context.getSharedPreferences(PushTokenState.PREFS_NAME, Context.MODE_PRIVATE)
            .edit().clear().commit()
        scheduled.clear()
        PushRegistration.forgetProcessObservation()
        PushRegistration.scheduler = PushRegistration.Scheduler { _, generation, token ->
            scheduled += generation to token
        }
    }

    @After
    fun restore() {
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
        PushRegistration.onNewToken(context, "T1")
        assertTrue("no session yet, nothing to ask", scheduled.isEmpty())

        assertTrue(PushRegistration.onPageSettled(context, messengerUrl, sessionCookie))

        assertEquals(listOf(1L to "T1"), scheduled)
    }

    @Test
    fun `navigating between authenticated pages asks for nothing`() {
        PushRegistration.onNewToken(context, "T1")
        PushRegistration.onPageSettled(context, messengerUrl, sessionCookie)
        scheduled.clear()

        assertFalse(PushRegistration.onPageSettled(context, conversationUrl, sessionCookie))
        assertFalse(PushRegistration.onPageSettled(context, messengerUrl, sessionCookie))

        assertTrue("ordinary navigation must not enqueue", scheduled.isEmpty())
    }

    @Test
    fun `a login is a new generation even when the token has not changed`() {
        PushRegistration.onNewToken(context, "T1")
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
        PushRegistration.onNewToken(context, "T1")
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

        PushRegistration.onNewToken(context, "T1")

        assertEquals(listOf(1L to "T1"), scheduled)
    }

    @Test
    fun `a rotated token is registered under the session already in place`() {
        PushRegistration.onNewToken(context, "T1")
        PushRegistration.onPageSettled(context, messengerUrl, sessionCookie)
        PushTokenState.applyRegisteredIfCurrent(context, 1L, "T1")
        scheduled.clear()

        PushRegistration.onNewToken(context, "T2")

        assertEquals(listOf(1L to "T2"), scheduled)
    }

    @Test
    fun `the same token again asks for nothing`() {
        PushRegistration.onNewToken(context, "T1")
        PushRegistration.onPageSettled(context, messengerUrl, sessionCookie)
        PushTokenState.applyRegisteredIfCurrent(context, 1L, "T1")
        scheduled.clear()

        PushRegistration.onNewToken(context, "T1")

        assertTrue(scheduled.isEmpty())
    }

    @Test
    fun `a refused device id is not retried until a new session`() {
        PushRegistration.onNewToken(context, "T1")
        PushRegistration.onPageSettled(context, messengerUrl, sessionCookie)
        PushTokenState.applyBlockIfCurrent(context, 1L, "T1", "PUSH_DEVICE_ID_NOT_STABLE")
        scheduled.clear()

        // Every page view in this session, and a rotated token too.
        PushRegistration.onPageSettled(context, conversationUrl, sessionCookie)
        PushRegistration.onNewToken(context, "T2")
        assertTrue("a block must not turn into a request per page", scheduled.isEmpty())

        PushRegistration.onPageSettled(context, loginUrl, null)
        PushRegistration.onPageSettled(context, messengerUrl, sessionCookie)

        assertEquals(listOf(2L to "T2"), scheduled)
    }

    @Test
    fun `a token conflict is retried by a different token without waiting for a login`() {
        PushRegistration.onNewToken(context, "T1")
        PushRegistration.onPageSettled(context, messengerUrl, sessionCookie)
        PushTokenState.applyBlockIfCurrent(context, 1L, "T1", PushTokenState.TOKEN_SCOPED_REASON)
        scheduled.clear()

        PushRegistration.onNewToken(context, "T2")

        assertEquals(listOf(1L to "T2"), scheduled)
    }
}
