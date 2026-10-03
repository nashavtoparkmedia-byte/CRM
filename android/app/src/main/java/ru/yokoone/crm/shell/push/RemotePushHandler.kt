package ru.yokoone.crm.shell.push

import android.content.Context
import ru.yokoone.crm.shell.ChatNotifications
import ru.yokoone.crm.shell.R

/**
 * Everything the shell does with a remote push, and the only place that does it.
 *
 * The provider adapter (PushMessagingService) hands its data map here and does
 * nothing else; acceptance injects a captured payload through this same entry
 * point rather than reimplementing the path it is supposed to be testing. There
 * is one implementation, so what acceptance proves is what a real push does.
 *
 * The order of operations is deliberate and is the opposite of the obvious one:
 *
 *     validate -> lock -> prune -> duplicate check -> post -> record
 *
 * Recording before posting would be safer against duplicates and worse against
 * loss: a process killed between the record and the post would leave a message
 * marked seen that the operator never saw, and no redelivery could recover it.
 * Posting first inverts the risk into a duplicate the operator can dismiss.
 * Neither ordering gives exactly-once display, and this one does not claim it.
 *
 * Nothing here touches the network. Receiving a push cannot mark a message
 * read, cannot tell the CRM anything, and cannot navigate anywhere by itself.
 */
object RemotePushHandler {

    /**
     * What happened, truthfully.
     *
     * [Accepted.notificationPosted] is false when the system refused the
     * notification — permission denied, or the channel muted to
     * IMPORTANCE_NONE. The payload was still valid and still new; it simply was
     * not shown, and it is deliberately NOT recorded as seen, so a redelivery
     * inside the FCM time-to-live can still reach an operator who has since
     * granted the permission.
     */
    sealed interface Outcome {
        data class Accepted(val notificationPosted: Boolean) : Outcome
        data object Duplicate : Outcome
        data class Rejected(val reason: String) : Outcome
    }

    /**
     * Serialises the whole check-post-record sequence.
     *
     * FirebaseMessagingService dispatches onMessageReceived on a background
     * executor and may run two deliveries at once; without this, two copies of
     * one message could both pass the duplicate check before either recorded.
     * The lock is process-wide, which is the same scope as the store it guards.
     */
    private val LOCK = Any()

    fun handle(
        context: Context,
        data: Map<String, String?>,
        now: Long = System.currentTimeMillis(),
    ): Outcome {
        val payload = when (val parsed = PushPayload.parse(data)) {
            is PushPayloadResult.Rejected -> return Outcome.Rejected(parsed.reason)
            is PushPayloadResult.Valid -> parsed.payload
        }

        synchronized(LOCK) {
            PushDedupStore.prune(context, now)
            if (PushDedupStore.hasSeen(context, payload.messageId)) return Outcome.Duplicate

            val posted = ChatNotifications.postChatNotification(
                context = context,
                notificationId = ChatNotifications.notificationIdFor(payload.chatId),
                chatId = payload.chatId,
                // Null on purpose. The payload's channel is the provider the
                // message arrived on, not a messenger tab, and the CRM's
                // /messages/open gate derives the tab from the conversation
                // itself. Mapping it here would create a second authority that
                // could disagree with the server.
                channelTab = null,
                messageId = payload.messageId,
                title = context.getString(R.string.push_notification_title),
                body = context.getString(R.string.push_notification_body),
            )

            if (posted) PushDedupStore.record(context, payload.messageId, now)
            return Outcome.Accepted(posted)
        }
    }
}
