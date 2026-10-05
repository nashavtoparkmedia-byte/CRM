package ru.yokoone.crm.shell.push

import ru.yokoone.crm.shell.CrmOrigin

/**
 * The one thing a remote push is allowed to be.
 *
 * The CRM sends data-only messages whose values are all strings. Two kinds are
 * understood, and they share a version and a validation philosophy rather than
 * each inventing one:
 *
 *     v          "1"
 *     kind       "chat_message" | "call_incoming" | "call_missed"
 *
 * chat_message (gravity-mvp/src/modules/messaging/internal/mobile-push/mobile-push-dispatch.ts):
 *
 *     chatId     conversation identifier
 *     messageId  message identifier, also the deduplication key
 *     channel    the conversation's provider, as the server stored it
 *
 * call_incoming / call_missed (gravity-mvp/src/modules/calling/internal/call-alerts/call-alert-dispatch.ts):
 *
 *     callId     call identifier
 *
 * Anything else is not a message this build understands, and the only safe
 * response to a payload this parser refuses is silence: no notification, no
 * navigation target, no record. A push cannot become an instruction.
 *
 * [ChatMessage.channel] is parsed because it is part of the contract and worth
 * asserting in acceptance, but it is NEVER used to choose where a tap lands. The
 * CRM derives the channel tab from the conversation itself, so a wrong or stale
 * value in a payload cannot mislead the UI. It is also not required: a missing
 * channel costs the operator nothing, and refusing the message over it would
 * suppress a notification for a message that really arrived.
 *
 * A call alert carries an identifier and nothing else. No phone number, no
 * contact name, no provider detail and no route: the tap target is fixed in this
 * app, so there is nothing a call payload could say that would move it.
 */
sealed interface PushPayload {

    /**
     * What makes a redelivery of this exact event a duplicate.
     *
     * A chat message dedupes on its own id. A call alert dedupes on the pair
     * (callId, kind), because one call legitimately produces an incoming alert
     * and later a missed alert and both must be shown. The two key spaces cannot
     * collide: [CrmOrigin.isSafeId] admits no ':', so no message id can ever
     * equal a call alert's composite key.
     */
    val dedupKey: String

    data class ChatMessage(
        val chatId: String,
        val messageId: String,
        val channel: String?,
    ) : PushPayload {
        override val dedupKey: String get() = messageId
    }

    data class CallAlert(
        val callId: String,
        val kind: CallAlertKind,
    ) : PushPayload {
        override val dedupKey: String get() = "${kind.wire}:$callId"
    }

    companion object {

        const val VERSION = "1"
        const val KIND_CHAT_MESSAGE = "chat_message"

        const val KEY_VERSION = "v"
        const val KEY_KIND = "kind"
        const val KEY_CHAT_ID = "chatId"
        const val KEY_MESSAGE_ID = "messageId"
        const val KEY_CHANNEL = "channel"
        const val KEY_CALL_ID = "callId"

        /**
         * Parse and validate, or say precisely why not.
         *
         * The reason is for diagnostics and tests. It never reaches a
         * notification, a URL or the CRM.
         */
        fun parse(data: Map<String, String?>): PushPayloadResult {
            if (data[KEY_VERSION]?.trim() != VERSION) return PushPayloadResult.Rejected("version")

            val kind = data[KEY_KIND]?.trim()
            val callAlertKind = CallAlertKind.fromWire(kind)
            return when {
                kind == KIND_CHAT_MESSAGE -> parseChatMessage(data)
                callAlertKind != null -> parseCallAlert(data, callAlertKind)
                else -> PushPayloadResult.Rejected("kind")
            }
        }

        private fun parseChatMessage(data: Map<String, String?>): PushPayloadResult {
            val chatId = data[KEY_CHAT_ID]?.trim().orEmpty()
            if (!CrmOrigin.isSafeId(chatId)) return PushPayloadResult.Rejected("chat_id")

            val messageId = data[KEY_MESSAGE_ID]?.trim().orEmpty()
            if (!CrmOrigin.isSafeId(messageId)) return PushPayloadResult.Rejected("message_id")

            val channel = data[KEY_CHANNEL]?.trim()?.takeIf { it.isNotEmpty() }
            return PushPayloadResult.Valid(ChatMessage(chatId, messageId, channel))
        }

        /**
         * A call alert is the identifier and the kind, and deliberately nothing
         * else. The same identifier shape the rest of the shell accepts bounds
         * it, so a call id cannot carry a path, a space or 65 characters.
         */
        private fun parseCallAlert(data: Map<String, String?>, kind: CallAlertKind): PushPayloadResult {
            val callId = data[KEY_CALL_ID]?.trim().orEmpty()
            if (!CrmOrigin.isSafeId(callId)) return PushPayloadResult.Rejected("call_id")
            return PushPayloadResult.Valid(CallAlert(callId, kind))
        }
    }
}

/** The two call events the CRM raises, and the wire value each one arrives as. */
enum class CallAlertKind(val wire: String) {
    INCOMING("call_incoming"),
    MISSED("call_missed"),
    ;

    companion object {
        fun fromWire(value: String?): CallAlertKind? = entries.firstOrNull { it.wire == value }
    }
}

sealed interface PushPayloadResult {
    data class Valid(val payload: PushPayload) : PushPayloadResult
    data class Rejected(val reason: String) : PushPayloadResult
}
