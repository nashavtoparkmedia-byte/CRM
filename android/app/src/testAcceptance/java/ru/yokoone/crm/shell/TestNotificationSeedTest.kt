package ru.yokoone.crm.shell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/**
 * Unit tests for the acceptance seed.
 *
 * They live in src/testAcceptance rather than src/test because the class under
 * test is compiled only into the acceptance variant now; a shared unit test
 * referencing it would stop the release and debug variants compiling, which is
 * precisely the boundary this milestone introduced.
 *
 * The in-origin URLs are built from CrmOrigin.ORIGIN instead of the production
 * host, because that is what the variant under test pins. The off-origin case
 * stays a literal: it must be refused whatever the pin happens to be.
 */
@RunWith(RobolectricTestRunner::class)
class TestNotificationSeedTest {

    @Test
    fun `the open conversation supplies the test target`() {
        val target = TestNotificationSeed.currentChatTarget(
            "${CrmOrigin.ORIGIN}/messages?id=chat_42&channel=max",
        )
        assertEquals("chat_42", target?.first)
        assertEquals("max", target?.second)
    }

    @Test
    fun `the chat list has no target and does not invent one`() {
        assertNull(TestNotificationSeed.currentChatTarget("${CrmOrigin.ORIGIN}/messages"))
    }

    @Test
    fun `a url outside the pin never becomes a target`() {
        assertNull(TestNotificationSeed.currentChatTarget("https://evil.example/messages?id=chat_42"))
        assertNull(TestNotificationSeed.currentChatTarget(null))
    }
}
