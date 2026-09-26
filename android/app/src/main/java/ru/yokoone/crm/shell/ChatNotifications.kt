package ru.yokoone.crm.shell

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat

/**
 * The shell's only notification entry point.
 *
 * Both callers reach the same code: the acceptance seed, which posts a local
 * notification to prove navigation, and [ru.yokoone.crm.shell.push.RemotePushHandler],
 * which posts one for a message that actually arrived. There is deliberately no
 * second implementation for remote push — a payload becomes a notification here
 * or not at all.
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
     * Post one conversation notification, and say truthfully whether the system
     * accepted it.
     *
     * [notificationId] is derived from the chat id by the caller so that
     * several chats produce several distinct, independently tappable
     * notifications rather than replacing one another.
     *
     * The channel is created here rather than relied upon. A remote message can
     * start this process with no Activity ever created, and on that path
     * nothing else would have run [ensureChannel]; creating an existing channel
     * is a no-op, so the cost is nothing and the alternative is a notification
     * silently dropped for want of a channel.
     *
     * The return value is `posted`, NOT "displayed". It is true when the app is
     * permitted to notify, the channel is not muted to IMPORTANCE_NONE, and the
     * platform accepted the notification without throwing. Whether and how the
     * system then presents it — heads-up, silent, on the lock screen, or folded
     * away — is not this app's decision and is not claimed here.
     */
    fun postChatNotification(
        context: Context,
        notificationId: Int,
        chatId: String,
        channelTab: String?,
        messageId: String?,
        title: String,
        body: String,
    ): Boolean {
        ensureChannel(context)

        val manager = NotificationManagerCompat.from(context)
        if (!manager.areNotificationsEnabled()) return false
        if (manager.getNotificationChannelCompat(CHANNEL_ID)?.importance == NotificationManager.IMPORTANCE_NONE) {
            return false
        }

        val intent = Intent(context, MainActivity::class.java).apply {
            action = Intent.ACTION_VIEW
            flags = launchFlagsFor(LiveActivities.any)
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
            //
            // CANCEL_CURRENT rather than UPDATE_CURRENT: two PendingIntents are
            // "the same" by Intent.filterEquals, which ignores both extras AND
            // flags. UPDATE_CURRENT would therefore hand back the one created
            // for a live Activity, keeping its launch flags, and the decision
            // below would silently have no effect. The notification is re-posted
            // under the same id in the same breath, so nothing the operator can
            // see is cancelled.
            PendingIntent.FLAG_CANCEL_CURRENT or PendingIntent.FLAG_IMMUTABLE,
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

        return runCatching { manager.notify(notificationId, notification) }.isSuccess
    }

    /**
     * How the tap must start the Activity, given whether one exists.
     *
     * MainActivity is `singleTask`, so a notification tap normally reaches the
     * one instance through onNewIntent and the task - including the WebView's
     * history - is kept. That is the CLEAR_TOP case and it is left exactly as
     * it was.
     *
     * When the system has destroyed the Activity but kept its task, that path
     * loses the target completely: measured on an API 34 emulator, the tap
     * relaunched the task's root from the task's OWN launcher intent
     * (`act=MAIN cats=LAUNCHER keys=none`) and onNewIntent was never called, so
     * the shell had nothing to aim at and fell back to the chat list. CLEAR_TASK
     * is the answer there because the task is the thing that is stale: its
     * Activity is gone and with it the WebView state that CLEAR_TOP exists to
     * preserve, so clearing it costs nothing and makes the Intent that starts
     * the Activity the one carrying the conversation.
     */
    internal fun launchFlagsFor(anyActivityAlive: Boolean): Int = when {
        anyActivityAlive -> Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
        else -> Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK
    }

    /** Stable, collision-resistant enough id per conversation. */
    fun notificationIdFor(chatId: String): Int = chatId.hashCode() and 0x7fffffff
}
