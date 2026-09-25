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

    private fun rejectionReason(data: Map<String, String?>): String {
        val result = PushPayload.parse(data)
        assertTrue("expected rejection, got $result", result is PushPayloadResult.Rejected)
        return (result as PushPayloadResult.Rejected).reason
    }

    @Test
    fun `the exact P1 payload parses`() {
        val result = PushPayload.parse(valid())
        assertTrue(result is PushPayloadResult.Valid)
        val payload = (result as PushPayloadResult.Valid).payload
        assertEquals("chat_abc123", payload.chatId)
        assertEquals("msg_abc123", payload.messageId)
        assertEquals("telegram", payload.channel)
    }

    @Test
    fun `channel is carried but is not required`() {
        val result = PushPayload.parse(valid("channel" to null))
        assertTrue(result is PushPayloadResult.Valid)
        assertNull((result as PushPayloadResult.Valid).payload.channel)
    }

    @Test
    fun `a future payload version is refused rather than guessed at`() {
        assertEquals("version", rejectionReason(valid("v" to "2")))
        assertEquals("version", rejectionReason(valid("v" to null)))
        assertEquals("version", rejectionReason(emptyMap()))
    }

    @Test
    fun `only the chat message kind is acted on`() {
        assertEquals("kind", rejectionReason(valid("kind" to "chat_read")))
        assertEquals("kind", rejectionReason(valid("kind" to null)))
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
        val result = PushPayload.parse(valid("chatId" to " chat_abc123 ", "v" to " 1 "))
        assertTrue(result is PushPayloadResult.Valid)
        assertEquals("chat_abc123", (result as PushPayloadResult.Valid).payload.chatId)
    }
}
