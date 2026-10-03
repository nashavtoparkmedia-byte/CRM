package ru.yokoone.crm.shell

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat

/**
 * Stage-1 acceptance aid, and nothing more.
 *
 * Proving deep-link navigation needs a notification to tap, and stage 1 has no
 * remote push. Rather than adding a button on top of the CRM interface — the
 * one thing this shell must not alter — the trigger lives in an ongoing,
 * silent notification with an action. It overlaps no CRM control, is reachable
 * from anywhere including the lock screen, and is obviously temporary.
 *
 * It builds its target from the conversation the operator currently has open,
 * so no chat identifier is compiled into the APK and the test always exercises
 * a real, reachable conversation. Opening a second conversation and tapping
 * again yields a second, independent notification — which is exactly the
 * "several notifications for different chats" case.
 *
 * A LOCAL notification proves the navigation contract. It does not prove
 * remote delivery, and this file is not evidence that push works.
 */
object TestNotificationSeed {

    private const val DIAGNOSTICS_CHANNEL_ID = "yoko_shell_diagnostics"
    /** Public so a test can name it instead of hard-coding the number. */
    const val DIAGNOSTICS_NOTIFICATION_ID = 1

    const val ACTION_SEED = "ru.yokoone.crm.shell.action.SEED_TEST_NOTIFICATION"

    fun ensureDiagnosticsNotification(context: Context) {
        if (isDiagnosticsDisabled(context)) {
            // Says so out loud: the proof that the hook ran and declined is what
            // separates "suppression held" from "no Activity was ever created".
            ShellDiagnostics.write("YOKO_NET fail push-aid suppressed")
            return
        }
        val manager = NotificationManagerCompat.from(context)
        manager.createNotificationChannel(
            NotificationChannel(
                DIAGNOSTICS_CHANNEL_ID,
                context.getString(R.string.diagnostics_channel_name),
                NotificationManager.IMPORTANCE_LOW,
            ),
        )

        val seedIntent = Intent(context, SeedReceiver::class.java).apply { action = ACTION_SEED }
        val seedPending = PendingIntent.getBroadcast(
            context,
            0,
            seedIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        val notification = NotificationCompat.Builder(context, DIAGNOSTICS_CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_message)
            .setContentTitle(context.getString(R.string.diagnostics_title))
            .setContentText(context.getString(R.string.diagnostics_text))
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setOngoing(true)
            .setShowWhen(false)
            .addAction(0, context.getString(R.string.diagnostics_action), seedPending)
            .build()

        runCatching { manager.notify(DIAGNOSTICS_NOTIFICATION_ID, notification) }
        ShellDiagnostics.write("YOKO_NET fail push-aid posted")
    }

    /**
     * Cancel the diagnostics notification, and only that one.
     *
     * This aid is acceptance-only: it is posted by ShellTestHooks, which exists
     * as a no-op in debug and release, so no shipped build ever has it. It is
     * ongoing, so it sits in the shade for the whole run, and while it is there
     * the app has two notifications and Android may fold them under a generated
     * group summary - a row that carries no contentIntent of its own and so
     * opens nothing when tapped. Measured on an API 34 emulator at process-dead
     * tap time: three notifications posted by this package, one of them a summary
     * at id 2147483647.
     *
     * Dismissing it before the process-dead push proof makes the acceptance
     * runtime resemble production, where this notification does not exist. It is
     * not a workaround for product behaviour: production grouping is untouched,
     * and the older scenarios that rely on this aid keep posting and using it.
     *
     * Deliberately not cancelAll(): cancelling the app's other notifications
     * would hide exactly the contamination the scenario has to expose.
     */
    fun dismissDiagnosticsNotification(context: Context) {
        NotificationManagerCompat.from(context).cancel(DIAGNOSTICS_NOTIFICATION_ID)
    }

    /** Acceptance-only state. Never touched by a shipped build, which has no seed. */
    private const val STATE_PREFS = "yoko_acceptance_aid"
    private const val KEY_DISABLED = "diagnostics_disabled"

    /** True once the push phase has taken the aid out of circulation. */
    fun isDiagnosticsDisabled(context: Context): Boolean = context
        .getSharedPreferences(STATE_PREFS, Context.MODE_PRIVATE)
        .getBoolean(KEY_DISABLED, false)

    /**
     * Retire the Stage-1 aid for the rest of this installation.
     *
     * Cancelling the notification is not enough on its own, and the previous
     * attempt proved it: ShellTestHooks re-posts the aid on every Activity start,
     * so any later start - the workflow relaunching the shell to have a process
     * to kill, or the tap itself - puts it straight back. While two notifications
     * are posted Android may fold them under a generated group summary, and that
     * summary then SURVIVES the aid being cancelled again: measured at
     * `active=2 inv=1934365641/yoko_chat_messages/row,2147483647/…/summary`, one
     * real notification and a summary that carries no contentIntent of its own.
     *
     * So the state is persisted, not remembered: commit(), not apply(), because
     * the very next thing this scenario expects is to have its process killed.
     * It survives Activity recreation, process death and a fresh process start.
     * A fresh install - every acceptance job does `pm clear` first - starts
     * enabled again, so the Stage-1 scenarios are unaffected.
     *
     * Cancels only its own notification. Product chat notifications are never
     * touched, and cancelAll() would hide the contamination the scenario exists
     * to expose.
     */
    fun disableForPushAcceptance(context: Context) {
        context.getSharedPreferences(STATE_PREFS, Context.MODE_PRIVATE)
            .edit()
            .putBoolean(KEY_DISABLED, true)
            .commit()
        dismissDiagnosticsNotification(context)
    }

    /**
     * Extract the conversation the shell is currently showing.
     *
     * Returns null when the operator is on the chat list rather than inside a
     * conversation — there is nothing to link to, and inventing a target would
     * make the test prove less than it appears to.
     */
    fun currentChatTarget(lastUrl: String?): Triple<String, String?, String?>? {
        if (!CrmOrigin.isInAppUrl(lastUrl)) return null
        val uri = runCatching { Uri.parse(lastUrl) }.getOrNull() ?: return null
        val chatId = uri.getQueryParameter("id")?.takeIf { it.isNotBlank() } ?: return null
        return Triple(chatId, uri.getQueryParameter("channel"), null)
    }

    class SeedReceiver : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            if (intent.action != ACTION_SEED) return

            val lastUrl = context
                .getSharedPreferences("yoko_shell", Context.MODE_PRIVATE)
                .getString("last_url", null)

            val target = currentChatTarget(lastUrl)
            if (target == null) {
                ChatNotifications.postChatNotification(
                    context = context,
                    notificationId = 2,
                    chatId = "",
                    channelTab = null,
                    messageId = null,
                    title = context.getString(R.string.test_no_chat_title),
                    body = context.getString(R.string.test_no_chat_text),
                )
                return
            }

            val (chatId, channelTab, messageId) = target
            ChatNotifications.postChatNotification(
                context = context,
                notificationId = ChatNotifications.notificationIdFor(chatId),
                chatId = chatId,
                channelTab = channelTab,
                messageId = messageId,
                title = context.getString(R.string.test_chat_title),
                body = context.getString(R.string.test_chat_text),
            )
        }
    }
}
