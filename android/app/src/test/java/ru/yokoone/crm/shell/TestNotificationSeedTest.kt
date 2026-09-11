package ru.yokoone.crm.shell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class TestNotificationSeedTest {

    @Test
    fun `the open conversation supplies the test target`() {
        val target = TestNotificationSeed.currentChatTarget(
            "https://yokoone.ru/messages?id=chat_42&channel=max",
        )
        assertEquals("chat_42", target?.first)
        assertEquals("max", target?.second)
    }

    @Test
    fun `the chat list has no target and does not invent one`() {
        assertNull(TestNotificationSeed.currentChatTarget("https://yokoone.ru/messages"))
    }

    @Test
    fun `a url outside the pin never becomes a target`() {
        assertNull(TestNotificationSeed.currentChatTarget("https://evil.example/messages?id=chat_42"))
        assertNull(TestNotificationSeed.currentChatTarget(null))
    }
}
