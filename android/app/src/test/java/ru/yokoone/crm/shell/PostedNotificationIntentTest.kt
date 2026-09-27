package ru.yokoone.crm.shell

import android.app.Notification
import android.content.Context
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf

/**
 * What the posted notification actually carries.
 *
 * On the device, tapping this notification after process death started the shell
 * from a plain launcher Intent - NEW_TASK only - which is what the system does
 * when a notification has nothing to open. So the question is whether the
 * contentIntent survives construction at all.
 */
@RunWith(RobolectricTestRunner::class)
class PostedNotificationIntentTest {

    private val context: Context get() = ApplicationProvider.getApplicationContext()

    @Test
    fun `the notification carries an intent aimed at this shell with the conversation on it`() {
        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as android.app.NotificationManager
        shadowOf(manager).setNotificationsEnabled(true)

        val posted = ChatNotifications.postChatNotification(
            context = context,
            notificationId = 7,
            chatId = "acc_chat_max_0005",
            channelTab = null,
            messageId = "m-1",
            title = "Новое сообщение",
            body = "Нажмите, чтобы открыть диалог",
        )
        assertEquals("the platform accepted it", true, posted)

        val notification: Notification = shadowOf(manager).allNotifications.single()
        assertNotNull("a notification with no contentIntent opens nothing", notification.contentIntent)

        val saved = shadowOf(notification.contentIntent).savedIntent
        assertEquals("aimed at this shell", MainActivity::class.java.name, saved.component?.className)
        assertEquals("a view of a conversation", android.content.Intent.ACTION_VIEW, saved.action)
        assertEquals(
            "carries the conversation",
            "acc_chat_max_0005",
            saved.getStringExtra(ChatNotifications.EXTRA_CHAT_ID),
        )
    }
}
