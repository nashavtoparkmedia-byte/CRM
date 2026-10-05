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
 *
 * Call alerts post through here too. The object keeps its name, which predates
 * them; renaming it would touch every call site for no behavioural gain and is
 * deliberately left out of the call-alert milestone.
 */
object ChatNotifications {

    const val CHANNEL_ID = "yoko_chat_messages"

    /**
     * Call alerts get their own channel, and both call kinds share it.
     *
     * A separate channel is the one thing Android's notification settings make
     * an operator-visible choice: with it, chat notifications can be silenced
     * without silencing calls, and the other way round. Splitting further, one
     * channel per call kind, would offer a distinction nobody asked for and
     * would double the settings surface for a single product idea.
     */
    const val CALL_ALERT_CHANNEL_ID = "yoko_call_alerts"

    const val EXTRA_CHAT_ID = "ru.yokoone.crm.shell.CHAT_ID"
    const val EXTRA_CHANNEL_TAB = "ru.yokoone.crm.shell.CHANNEL_TAB"
    const val EXTRA_MESSAGE_ID = "ru.yokoone.crm.shell.MESSAGE_ID"

    /**
     * Marks a tap as coming from a call alert.
     *
     * It carries the kind, not a route: the destination is built in this app
     * from [CrmOrigin.callsUrl], so nothing a payload says can move it.
     */
    const val EXTRA_CALL_ALERT_KIND = "ru.yokoone.crm.shell.CALL_ALERT_KIND"

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

    fun ensureCallAlertChannel(context: Context) {
        val channel = NotificationChannel(
            CALL_ALERT_CHANNEL_ID,
            context.getString(R.string.call_alert_channel_name),
            NotificationManager.IMPORTANCE_HIGH,
        ).apply {
            description = context.getString(R.string.call_alert_channel_description)
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

        return runCatching { manager.notify(notificationId, notification) }.isSuccess
    }

    /**
     * Post one call alert, and say truthfully whether the system accepted it.
     *
     * Title-only on purpose: the payload carries an identifier and a kind, so
     * there is no honest second line to write. A body would have to be either
     * filler or enrichment the contract deliberately withholds.
     *
     * The intent carries the kind and no route. [MainActivity] rebuilds the
     * destination from the pinned origin, exactly as it does for a chat tap.
     */
    fun postCallAlertNotification(
        context: Context,
        notificationId: Int,
        callAlertKind: String,
        title: String,
    ): Boolean {
        ensureCallAlertChannel(context)

        val manager = NotificationManagerCompat.from(context)
        if (!manager.areNotificationsEnabled()) return false
        if (manager.getNotificationChannelCompat(CALL_ALERT_CHANNEL_ID)?.importance == NotificationManager.IMPORTANCE_NONE) {
            return false
        }

        val intent = Intent(context, MainActivity::class.java).apply {
            action = Intent.ACTION_VIEW
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
            putExtra(EXTRA_CALL_ALERT_KIND, callAlertKind)
        }

        val pending = PendingIntent.getActivity(
            context,
            notificationId,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        val notification = NotificationCompat.Builder(context, CALL_ALERT_CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_message)
            .setContentTitle(title)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setAutoCancel(true)
            .setContentIntent(pending)
            .build()

        return runCatching { manager.notify(notificationId, notification) }.isSuccess
    }

    /**
     * Stable, collision-resistant enough id per notification key.
     *
     * A conversation passes its chat id; a call alert passes its (kind, callId)
     * deduplication key, so an incoming alert and a later missed alert for the
     * same call are two notifications rather than one replacing the other.
     */
    fun notificationIdFor(chatId: String): Int = chatId.hashCode() and 0x7fffffff
}
