package ru.yokoone.crm.shell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/**
 * The shell's security properties are all decided by pure functions, so they
 * are asserted here rather than argued for in a report.
 */
@RunWith(RobolectricTestRunner::class)
class CrmOriginTest {

    @Test
    fun `start url is the messenger on the pinned origin`() {
        assertEquals("https://yokoone.ru/messages", CrmOrigin.startUrl())
    }

    @Test
    fun `pinned origin and its www alias render in app`() {
        assertTrue(CrmOrigin.isInAppUrl("https://yokoone.ru/messages?id=abc"))
        assertTrue(CrmOrigin.isInAppUrl("https://www.yokoone.ru/messages"))
    }

    @Test
    fun `everything off origin is refused`() {
        assertFalse(CrmOrigin.isInAppUrl("https://evil.example/messages"))
        // Suffix confusion: a host that merely ends with the pinned host.
        assertFalse(CrmOrigin.isInAppUrl("https://yokoone.ru.evil.example/"))
        // Userinfo confusion: the real host is the attacker's.
        assertFalse(CrmOrigin.isInAppUrl("https://yokoone.ru@evil.example/"))
        // A subdomain is a different origin and is not covered by the pin.
        assertFalse(CrmOrigin.isInAppUrl("https://app.yokoone.ru/messages"))
        assertFalse(CrmOrigin.isInAppUrl(null))
        assertFalse(CrmOrigin.isInAppUrl(""))
        assertFalse(CrmOrigin.isInAppUrl("/messages"))
    }

    @Test
    fun `plain http on the pinned host is refused`() {
        assertFalse(CrmOrigin.isInAppUrl("http://yokoone.ru/messages"))
    }

    @Test
    fun `the shipped release origin is https`() {
        // The testing variant may pin a cleartext origin against a disposable
        // backend. The build that talks to production must not.
        assertTrue(CrmOrigin.ORIGIN.startsWith("https://"))
        assertFalse(BuildConfig.IS_TEST_BUILD)
    }

    @Test
    fun `a different port on the pinned host is a different origin`() {
        assertFalse(CrmOrigin.isInAppUrl("https://yokoone.ru:8443/messages"))
    }

    @Test
    fun `the shell declares its lane marker`() {
        // The CRM keys its stricter mobile rules on this exact string.
        assertEquals("YokoShell/", CrmOrigin.SHELL_UA_TOKEN)
    }

    @Test
    fun `hostile schemes are never handed to another app`() {
        assertFalse(CrmOrigin.isLaunchableExternally("javascript:alert(1)"))
        assertFalse(CrmOrigin.isLaunchableExternally("file:///data/data/ru.yokoone.crm.shell/"))
        assertFalse(CrmOrigin.isLaunchableExternally("content://media/external/images/1"))
        assertFalse(CrmOrigin.isLaunchableExternally("intent://scan/#Intent;scheme=zxing;end"))
    }

    @Test
    fun `ordinary outbound links are handed to another app`() {
        assertTrue(CrmOrigin.isLaunchableExternally("https://t.me/some_channel"))
        assertTrue(CrmOrigin.isLaunchableExternally("tel:+79990000000"))
        assertTrue(CrmOrigin.isLaunchableExternally("mailto:a@example.com"))
    }

    @Test
    fun `an in app url is never treated as external`() {
        assertFalse(CrmOrigin.isLaunchableExternally("https://yokoone.ru/messages"))
    }

    @Test
    fun `a notification target becomes a server gate url, not a messenger url`() {
        val url = CrmOrigin.buildOpenChatUrl("cly7k2p4x0001abcd", "tg", null)
        assertEquals("https://yokoone.ru/messages/open?chat=cly7k2p4x0001abcd&channel=tg", url)
    }

    @Test
    fun `a message id is carried through when it is well formed`() {
        val url = CrmOrigin.buildOpenChatUrl("chat_1", "wa", "msg_9")
        assertEquals("https://yokoone.ru/messages/open?chat=chat_1&channel=wa&msg=msg_9", url)
    }

    @Test
    fun `an unknown channel tab is dropped rather than forwarded`() {
        val url = CrmOrigin.buildOpenChatUrl("chat_1", "../../admin", null)
        assertEquals("https://yokoone.ru/messages/open?chat=chat_1", url)
    }

    @Test
    fun `a payload that is not a plain identifier produces no navigation`() {
        assertNull(CrmOrigin.buildOpenChatUrl("https://evil.example/", null, null))
        assertNull(CrmOrigin.buildOpenChatUrl("../../settings", null, null))
        assertNull(CrmOrigin.buildOpenChatUrl("a b", null, null))
        assertNull(CrmOrigin.buildOpenChatUrl("", null, null))
        assertNull(CrmOrigin.buildOpenChatUrl(null, null, null))
        assertNull(CrmOrigin.buildOpenChatUrl("x".repeat(65), null, null))
    }

    @Test
    fun `a malformed message id is dropped but the chat still opens`() {
        val url = CrmOrigin.buildOpenChatUrl("chat_1", null, "../../secret")
        assertEquals("https://yokoone.ru/messages/open?chat=chat_1", url)
    }

    @Test
    fun `restored state is re-validated against the pin`() {
        assertEquals(
            "https://yokoone.ru/messages?id=abc",
            CrmOrigin.sanitizeRestoredUrl("https://yokoone.ru/messages?id=abc"),
        )
        assertNull(CrmOrigin.sanitizeRestoredUrl("https://evil.example/"))
        assertNull(CrmOrigin.sanitizeRestoredUrl("javascript:alert(1)"))
        assertNull(CrmOrigin.sanitizeRestoredUrl(null))
    }
}
