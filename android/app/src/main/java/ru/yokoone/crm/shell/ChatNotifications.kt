package ru.yokoone.crm.shell

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat

/**
 * Stage-1 notification entry point.
 *
 * The notifications posted here are LOCAL and exist to prove the navigation
 * contract end to end: cold start, warm start, expired session, and several
 * notifications for different chats at once. They are not remote push; no FCM
 * token is registered and nothing arrives from a server. The native boundary
 * that a later stage plugs FCM into is [postChatNotification] — a remote
 * message handler would call exactly this and nothing else would change.
 *
 * Two invariants live here:
 *
 *  - Posting or tapping a notification performs NO network request. The shell
 *    never tells the CRM that a message was seen, so a notification cannot
 *    mark anything read. Read state stays entirely with the CRM Messenger,
 *    which decides it when the operator actually opens the conversation.
 *  - The notification carries a chat identifier, not a URL. Navigation is
 *    rebuilt by [CrmOrigin.buildOpenChatUrl] against the pinned origin and is
 *    then re-checked by the CRM, so a payload cannot steer the shell.
 */
object ChatNotifications {

    const val CHANNEL_ID = "yoko_chat_messages"

    const val EXTRA_CHAT_ID = "ru.yokoone.crm.shell.CHAT_ID"
    const val EXTRA_CHANNEL_TAB = "ru.yokoone.crm.shell.CHANNEL_TAB"
    const val EXTRA_MESSAGE_ID = "ru.yokoone.crm.shell.MESSAGE_ID"

    fun ensureChannel(context: Context) {
        val channel = NotificationChannel(
            CHANNEL_ID,
            context.getString(R.string.notification_channel_name),
            NotificationManager.IMPORTANCE_HIGH,
        ).apply {
            description = context.getString(R.string.notification_channel_description)
        }
        NotificationManagerCompat.from(context).createNotificationChannel(channel)
    }

    /**
     * Post one conversation notification.
     *
     * [notificationId] is derived from the chat id by the caller so that
     * several chats produce several distinct, independently tappable
     * notifications rather than replacing one another.
     */
    fun postChatNotification(
        context: Context,
        notificationId: Int,
        chatId: String,
        channelTab: String?,
        messageId: String?,
        title: String,
        body: String,
    ) {
        val intent = Intent(context, MainActivity::class.java).apply {
            action = Intent.ACTION_VIEW
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
            putExtra(EXTRA_CHAT_ID, chatId)
            putExtra(EXTRA_CHANNEL_TAB, channelTab)
            putExtra(EXTRA_MESSAGE_ID, messageId)
        }

        val pending = PendingIntent.getActivity(
            context,
            notificationId,
            intent,
            // IMMUTABLE: another app must not be able to rewrite the extras and
            // aim this shell at a different conversation.
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        val notification = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_message)
            .setContentTitle(title)
            .setContentText(body)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setAutoCancel(true)
            .setContentIntent(pending)
            .build()

        runCatching {
            NotificationManagerCompat.from(context).notify(notificationId, notification)
        }
    }

    /** Stable, collision-resistant enough id per conversation. */
    fun notificationIdFor(chatId: String): Int = chatId.hashCode() and 0x7fffffff
}
