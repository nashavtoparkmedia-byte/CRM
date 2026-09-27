package ru.yokoone.crm.shell.push

import android.app.NotificationManager
import android.content.Context
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import ru.yokoone.crm.shell.ChatNotifications

/**
 * What a remote push is allowed to do to the device.
 *
 * The cases that must produce nothing are as important as the one that must
 * produce a notification, and the permission case is the one that decides
 * whether this shell tells the truth about what the operator saw.
 */
@RunWith(RobolectricTestRunner::class)
class RemotePushHandlerTest {

    private val context: Context get() = ApplicationProvider.getApplicationContext()
    private val notifications get() = shadowOf(context.getSystemService(NotificationManager::class.java))
    private val now = 1_700_000_000_000L

    private val payload = mapOf(
        "v" to "1",
        "kind" to "chat_message",
        "chatId" to "chat_abc123",
        "messageId" to "msg_abc123",
        "channel" to "telegram",
    )

    @Test
    fun `a valid push posts exactly one notification and records it`() {
        val outcome = RemotePushHandler.handle(context, payload, now)

        assertEquals(RemotePushHandler.Outcome.Accepted(notificationPosted = true), outcome)
        assertEquals(1, notifications.size())
        assertTrue(PushDedupStore.hasSeen(context, "msg_abc123"))
    }

    @Test
    fun `the notification carries identifiers, no channel tab and no url`() {
        RemotePushHandler.handle(context, payload, now)

        val posted = notifications.allNotifications.single()
        val target = shadowOf(posted.contentIntent).savedIntent

        assertEquals("chat_abc123", target.getStringExtra(ChatNotifications.EXTRA_CHAT_ID))
        assertEquals("msg_abc123", target.getStringExtra(ChatNotifications.EXTRA_MESSAGE_ID))
        // The payload said "telegram"; the shell deliberately forwards no tab
        // and lets the CRM gate derive it from the conversation itself.
        assertNull(target.getStringExtra(ChatNotifications.EXTRA_CHANNEL_TAB))
        assertNull(target.data)
    }

    @Test
    fun `the same message delivered twice is shown once`() {
        RemotePushHandler.handle(context, payload, now)
        val second = RemotePushHandler.handle(context, payload, now + 5_000)

        assertEquals(RemotePushHandler.Outcome.Duplicate, second)
        assertEquals(1, notifications.size())
    }

    @Test
    fun `a message seen longer ago than retention is no longer suppressed`() {
        RemotePushHandler.handle(context, payload, now)
        val later = RemotePushHandler.handle(context, payload, now + PushDedupStore.RETENTION_MS + 1)

        assertEquals(RemotePushHandler.Outcome.Accepted(notificationPosted = true), later)
    }

    @Test
    fun `a refused payload produces no notification and no record`() {
        for (broken in listOf(
            payload - "chatId",
            payload - "messageId",
            payload + ("v" to "2"),
            payload + ("kind" to "chat_read"),
            payload + ("chatId" to "not a chat id"),
            emptyMap(),
        )) {
            val outcome = RemotePushHandler.handle(context, broken, now)
            assertTrue("expected rejection for $broken", outcome is RemotePushHandler.Outcome.Rejected)
        }

        assertEquals(0, notifications.size())
        assertFalse(PushDedupStore.hasSeen(context, "msg_abc123"))
    }

    @Test
    fun `a push the system will not show is not recorded as seen`() {
        notifications.setNotificationsEnabled(false)

        val refused = RemotePushHandler.handle(context, payload, now)

        assertEquals(RemotePushHandler.Outcome.Accepted(notificationPosted = false), refused)
        assertEquals(0, notifications.size())
        // The point of the whole ordering: nothing was shown, so nothing may be
        // remembered as shown.
        assertFalse(PushDedupStore.hasSeen(context, "msg_abc123"))
    }

    @Test
    fun `granting the permission later lets a redelivery still reach the operator`() {
        notifications.setNotificationsEnabled(false)
        RemotePushHandler.handle(context, payload, now)

        notifications.setNotificationsEnabled(true)
        val redelivered = RemotePushHandler.handle(context, payload, now + 60_000)

        assertEquals(RemotePushHandler.Outcome.Accepted(notificationPosted = true), redelivered)
        assertEquals(1, notifications.size())
        assertTrue(PushDedupStore.hasSeen(context, "msg_abc123"))
    }
}
