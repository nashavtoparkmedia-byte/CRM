package ru.yokoone.crm.shell.push

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/**
 * The payload contract, asserted rather than described.
 *
 * Every rejection below is a payload that must produce NO notification at all.
 * A push that this parser does not fully understand is not a weaker push; it is
 * one the shell has no business acting on.
 */
@RunWith(RobolectricTestRunner::class)
class PushPayloadTest {

    private fun valid(vararg overrides: Pair<String, String?>): Map<String, String?> =
        mutableMapOf<String, String?>(
            "v" to "1",
            "kind" to "chat_message",
            "chatId" to "chat_abc123",
            "messageId" to "msg_abc123",
            "channel" to "telegram",
        ).apply { overrides.forEach { (key, value) -> if (value == null) remove(key) else put(key, value) } }

    private fun callAlert(vararg overrides: Pair<String, String?>): Map<String, String?> =
        mutableMapOf<String, String?>(
            "v" to "1",
            "kind" to "call_incoming",
            "callId" to "call_abc123",
        ).apply { overrides.forEach { (key, value) -> if (value == null) remove(key) else put(key, value) } }

    private fun rejectionReason(data: Map<String, String?>): String {
        val result = PushPayload.parse(data)
        assertTrue("expected rejection, got $result", result is PushPayloadResult.Rejected)
        return (result as PushPayloadResult.Rejected).reason
    }

    private fun chat(data: Map<String, String?>): PushPayload.ChatMessage {
        val result = PushPayload.parse(data)
        assertTrue("expected acceptance, got $result", result is PushPayloadResult.Valid)
        val payload = (result as PushPayloadResult.Valid).payload
        assertTrue("expected a chat message, got $payload", payload is PushPayload.ChatMessage)
        return payload as PushPayload.ChatMessage
    }

    private fun call(data: Map<String, String?>): PushPayload.CallAlert {
        val result = PushPayload.parse(data)
        assertTrue("expected acceptance, got $result", result is PushPayloadResult.Valid)
        val payload = (result as PushPayloadResult.Valid).payload
        assertTrue("expected a call alert, got $payload", payload is PushPayload.CallAlert)
        return payload as PushPayload.CallAlert
    }

    @Test
    fun `the exact P1 payload parses`() {
        val payload = chat(valid())
        assertEquals("chat_abc123", payload.chatId)
        assertEquals("msg_abc123", payload.messageId)
        assertEquals("telegram", payload.channel)
    }

    @Test
    fun `channel is carried but is not required`() {
        assertNull(chat(valid("channel" to null)).channel)
    }

    @Test
    fun `a future payload version is refused rather than guessed at`() {
        assertEquals("version", rejectionReason(valid("v" to "2")))
        assertEquals("version", rejectionReason(valid("v" to null)))
        assertEquals("version", rejectionReason(emptyMap()))
    }

    @Test
    fun `only the kinds this build understands are acted on`() {
        assertEquals("kind", rejectionReason(valid("kind" to "chat_read")))
        assertEquals("kind", rejectionReason(valid("kind" to null)))
        assertEquals("kind", rejectionReason(callAlert("kind" to "call_answered")))
        assertEquals("kind", rejectionReason(callAlert("kind" to "CALL_INCOMING")))
    }

    @Test
    fun `a missing or malformed chat id produces nothing`() {
        assertEquals("chat_id", rejectionReason(valid("chatId" to null)))
        assertEquals("chat_id", rejectionReason(valid("chatId" to "")))
        assertEquals("chat_id", rejectionReason(valid("chatId" to "../../etc/passwd")))
        assertEquals("chat_id", rejectionReason(valid("chatId" to "chat abc")))
        assertEquals("chat_id", rejectionReason(valid("chatId" to "c".repeat(65))))
    }

    @Test
    fun `a missing or malformed message id produces nothing`() {
        // The message id is also the deduplication key, so an unusable one is
        // not a cosmetic problem: it would mean a notification that can be
        // shown twice with no record able to stop it.
        assertEquals("message_id", rejectionReason(valid("messageId" to null)))
        assertEquals("message_id", rejectionReason(valid("messageId" to "")))
        assertEquals("message_id", rejectionReason(valid("messageId" to "msg/42")))
        assertEquals("message_id", rejectionReason(valid("messageId" to "m".repeat(65))))
    }

    @Test
    fun `surrounding whitespace does not change the meaning of a value`() {
        assertEquals("chat_abc123", chat(valid("chatId" to " chat_abc123 ", "v" to " 1 ")).chatId)
        assertEquals("call_abc123", call(callAlert("callId" to " call_abc123 ", "v" to " 1 ")).callId)
    }

    // ------------------------------------------------------------------
    // Call alerts. The wire contract is exactly {v, kind, callId}; anything
    // richer is a contract the backend did not agree to send.
    // ------------------------------------------------------------------

    @Test
    fun `an incoming call alert parses`() {
        val payload = call(callAlert())
        assertEquals("call_abc123", payload.callId)
        assertEquals(CallAlertKind.INCOMING, payload.kind)
    }

    @Test
    fun `a missed call alert parses`() {
        val payload = call(callAlert("kind" to "call_missed"))
        assertEquals("call_abc123", payload.callId)
        assertEquals(CallAlertKind.MISSED, payload.kind)
    }

    @Test
    fun `a call alert version is checked exactly as a message version is`() {
        assertEquals("version", rejectionReason(callAlert("v" to "2")))
        assertEquals("version", rejectionReason(callAlert("v" to null)))
    }

    @Test
    fun `a missing or malformed call id produces nothing`() {
        assertEquals("call_id", rejectionReason(callAlert("callId" to null)))
        assertEquals("call_id", rejectionReason(callAlert("callId" to "")))
        assertEquals("call_id", rejectionReason(callAlert("callId" to "   ")))
        assertEquals("call_id", rejectionReason(callAlert("callId" to "../../etc/passwd")))
        assertEquals("call_id", rejectionReason(callAlert("callId" to "call abc")))
        assertEquals("call_id", rejectionReason(callAlert("callId" to "c".repeat(65))))
        assertEquals("call_id", rejectionReason(callAlert("kind" to "call_missed", "callId" to null)))
    }

    @Test
    fun `a call alert reads nothing but its identifier`() {
        // Whatever else a payload carries, the parsed alert is the id and the
        // kind. Nothing here can become a route, a number or a name.
        val payload = call(
            callAlert(
                "chatId" to "chat_abc123",
                "messageId" to "msg_abc123",
                "channel" to "telegram",
                "phone" to "+70000000000",
                "url" to "https://evil.example/pwn",
            ),
        )
        assertEquals(PushPayload.CallAlert("call_abc123", CallAlertKind.INCOMING), payload)
    }

    @Test
    fun `the two kinds of push cannot share a deduplication key`() {
        // A call alert's key is composite and a message id can never contain a
        // colon, so no call alert can suppress a message or the other way round.
        assertEquals("call_incoming:call_abc123", call(callAlert()).dedupKey)
        assertEquals("call_missed:call_abc123", call(callAlert("kind" to "call_missed")).dedupKey)
        assertEquals("msg_abc123", chat(valid()).dedupKey)
    }
}
