package ru.yokoone.crm.shell.push

import ru.yokoone.crm.shell.CrmOrigin

/**
 * The one thing a remote push is allowed to be.
 *
 * Mobile Push v1 sends a data-only message whose five values are all strings
 * (gravity-mvp/src/modules/messaging/internal/mobile-push/mobile-push-dispatch.ts):
 *
 *     v          "1"
 *     kind       "chat_message"
 *     chatId     conversation identifier
 *     messageId  message identifier, also the deduplication key
 *     channel    the conversation's provider, as the server stored it
 *
 * Anything else is not a message this build understands, and the only safe
 * response to a payload this parser refuses is silence: no notification, no
 * navigation target, no record. A push cannot become an instruction.
 *
 * [channel] is parsed because it is part of the contract and worth asserting
 * in acceptance, but it is NEVER used to choose where a tap lands. The CRM
 * derives the channel tab from the conversation itself, so a wrong or stale
 * value in a payload cannot mislead the UI. It is also not required: a missing
 * channel costs the operator nothing, and refusing the message over it would
 * suppress a notification for a message that really arrived.
 */
data class PushPayload(
    val chatId: String,
    val messageId: String,
    val channel: String?,
) {

    companion object {

        const val VERSION = "1"
        const val KIND_CHAT_MESSAGE = "chat_message"

        const val KEY_VERSION = "v"
        const val KEY_KIND = "kind"
        const val KEY_CHAT_ID = "chatId"
        const val KEY_MESSAGE_ID = "messageId"
        const val KEY_CHANNEL = "channel"

        /**
         * Parse and validate, or say precisely why not.
         *
         * The reason is for diagnostics and tests. It never reaches a
         * notification, a URL or the CRM.
         */
        fun parse(data: Map<String, String?>): PushPayloadResult {
            if (data[KEY_VERSION]?.trim() != VERSION) return PushPayloadResult.Rejected("version")
            if (data[KEY_KIND]?.trim() != KIND_CHAT_MESSAGE) return PushPayloadResult.Rejected("kind")

            val chatId = data[KEY_CHAT_ID]?.trim().orEmpty()
            if (!CrmOrigin.isSafeId(chatId)) return PushPayloadResult.Rejected("chat_id")

            val messageId = data[KEY_MESSAGE_ID]?.trim().orEmpty()
            if (!CrmOrigin.isSafeId(messageId)) return PushPayloadResult.Rejected("message_id")

            val channel = data[KEY_CHANNEL]?.trim()?.takeIf { it.isNotEmpty() }
            return PushPayloadResult.Valid(PushPayload(chatId, messageId, channel))
        }
    }
}

sealed interface PushPayloadResult {
    data class Valid(val payload: PushPayload) : PushPayloadResult
    data class Rejected(val reason: String) : PushPayloadResult
}
