package ru.yokoone.crm.shell.push

import android.app.NotificationManager
import android.content.Context
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
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

    // ----------------------------------------------------------------------
    // Call alerts. Same handler, same store, same lock: the only thing that
    // differs is what the payload means and what the operator is shown.
    // ----------------------------------------------------------------------

    private val incoming = mapOf("v" to "1", "kind" to "call_incoming", "callId" to "call_abc123")
    private val missed = mapOf("v" to "1", "kind" to "call_missed", "callId" to "call_abc123")

    private fun title(index: Int = 0) =
        notifications.allNotifications[index].extras.getString(android.app.Notification.EXTRA_TITLE)

    @Test
    fun `an incoming call alert posts exactly one notification with the incoming title`() {
        val outcome = RemotePushHandler.handle(context, incoming, now)

        assertEquals(RemotePushHandler.Outcome.Accepted(notificationPosted = true), outcome)
        assertEquals(1, notifications.size())
        assertEquals("Входящий звонок", title())
        assertTrue(PushDedupStore.hasSeen(context, "call_incoming:call_abc123"))
    }

    @Test
    fun `a missed call alert posts exactly one notification with the missed title`() {
        val outcome = RemotePushHandler.handle(context, missed, now)

        assertEquals(RemotePushHandler.Outcome.Accepted(notificationPosted = true), outcome)
        assertEquals(1, notifications.size())
        assertEquals("Пропущенный звонок", title())
        assertTrue(PushDedupStore.hasSeen(context, "call_missed:call_abc123"))
    }

    @Test
    fun `a call alert carries the kind and no conversation, and no url`() {
        RemotePushHandler.handle(context, incoming, now)

        val posted = notifications.allNotifications.single()
        val target = shadowOf(posted.contentIntent).savedIntent

        assertEquals("call_incoming", target.getStringExtra(ChatNotifications.EXTRA_CALL_ALERT_KIND))
        assertNull(target.getStringExtra(ChatNotifications.EXTRA_CHAT_ID))
        assertNull(target.getStringExtra(ChatNotifications.EXTRA_MESSAGE_ID))
        assertNull(target.data)
    }

    @Test
    fun `the same call alert delivered twice is shown once`() {
        assertEquals(RemotePushHandler.Outcome.Accepted(true), RemotePushHandler.handle(context, incoming, now))
        assertEquals(RemotePushHandler.Outcome.Duplicate, RemotePushHandler.handle(context, incoming, now))
        assertEquals(1, notifications.size())

        assertEquals(RemotePushHandler.Outcome.Accepted(true), RemotePushHandler.handle(context, missed, now))
        assertEquals(RemotePushHandler.Outcome.Duplicate, RemotePushHandler.handle(context, missed, now))
        assertEquals(2, notifications.size())
    }

    @Test
    fun `one call ringing and then missed is two alerts, not one replacing the other`() {
        RemotePushHandler.handle(context, incoming, now)
        RemotePushHandler.handle(context, missed, now)

        assertEquals(2, notifications.size())
        assertEquals(setOf("Входящий звонок", "Пропущенный звонок"), notifications.allNotifications.map {
            it.extras.getString(android.app.Notification.EXTRA_TITLE)
        }.toSet())
        // Distinct ids are what keeps both on screen; equal ids would have let
        // the second silently replace the first.
        assertEquals(2, notifications.allNotifications.map { it.hashCode() }.size)
        assertNotEquals(
            ChatNotifications.notificationIdFor("call_incoming:call_abc123"),
            ChatNotifications.notificationIdFor("call_missed:call_abc123"),
        )
    }

    @Test
    fun `a call alert the system will not show is not recorded as seen`() {
        shadowOf(context.getSystemService(NotificationManager::class.java)).setNotificationsEnabled(false)

        val outcome = RemotePushHandler.handle(context, incoming, now)

        assertEquals(RemotePushHandler.Outcome.Accepted(notificationPosted = false), outcome)
        assertFalse(PushDedupStore.hasSeen(context, "call_incoming:call_abc123"))
    }

    @Test
    fun `a malformed call alert produces no notification and no record`() {
        for (bad in listOf(
            incoming - "callId",
            incoming + ("callId" to ""),
            incoming + ("kind" to "call_answered"),
            incoming + ("v" to "2"),
        )) {
            val outcome = RemotePushHandler.handle(context, bad, now)
            assertTrue("expected rejection for $bad, got $outcome", outcome is RemotePushHandler.Outcome.Rejected)
        }
        assertEquals(0, notifications.size())
    }

    @Test
    fun `a call alert and a chat message do not suppress one another`() {
        RemotePushHandler.handle(context, payload, now)
        val outcome = RemotePushHandler.handle(context, incoming, now)

        assertEquals(RemotePushHandler.Outcome.Accepted(notificationPosted = true), outcome)
        assertEquals(2, notifications.size())
    }
}
