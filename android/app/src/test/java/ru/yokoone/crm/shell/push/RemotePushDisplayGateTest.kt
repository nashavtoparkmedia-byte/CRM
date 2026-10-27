package ru.yokoone.crm.shell.push

import android.app.NotificationManager
import android.content.Context
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import ru.yokoone.crm.shell.EdgeContextReset
import ru.yokoone.crm.shell.EdgeTestSupport

/**
 * T35 (unit part): after an edge context reset no remote push is displayed
 * until a registration with a current ticket returned 200 (R5.1 §5.3, §5.7.3).
 */
@RunWith(RobolectricTestRunner::class)
class RemotePushDisplayGateTest {

    private val context: Context get() = ApplicationProvider.getApplicationContext()
    private val notifications get() = shadowOf(context.getSystemService(NotificationManager::class.java))
    private val now = 1_700_000_000_000L

    private fun payload(messageId: String) = mapOf(
        "v" to "1",
        "kind" to "chat_message",
        "chatId" to "chat_abc123",
        "messageId" to messageId,
        "channel" to "telegram",
    )

    @Before
    fun setUp() {
        EdgeTestSupport.reset(context)
    }

    @Test
    fun `a fresh install displays pushes`() {
        assertEquals(RemotePushHandler.Outcome.Accepted(true), RemotePushHandler.handle(context, payload("msg_1"), now))
    }

    @Test
    fun `after a reset pushes are suppressed, not recorded, until a current-ticket 200`() {
        PushTokenState.rememberToken(context, "T1")
        PushTokenState.beginReset(context, EdgeContextReset.Reason.OPERATOR_SWITCH, now, 0L)

        assertEquals(RemotePushHandler.Outcome.Suppressed, RemotePushHandler.handle(context, payload("msg_2"), now))
        assertEquals(0, notifications.size())
        assertFalse("a suppressed push is not marked seen", PushDedupStore.hasSeen(context, "msg_2"))

        PushTokenState.completeReset(context)
        assertEquals(RemotePushHandler.Outcome.Suppressed, RemotePushHandler.handle(context, payload("msg_2"), now))

        // A new token under a new generation, registered with a current ticket.
        val epoch = PushTokenState.resetEpoch(context)
        PushTokenState.commitToken(context, epoch, PushTokenState.CommitKind.ROTATE, "T2", deleteSucceeded = true)
        val generation = PushTokenState.startSessionGeneration(context).sessionGeneration
        PushRegistrationWork.run(context, generation, "T2", 0) { PushRegistrar.Outcome.Registered }

        assertEquals(RemotePushHandler.Outcome.Accepted(true), RemotePushHandler.handle(context, payload("msg_2"), now))
        assertEquals(1, notifications.size())
    }

    @Test
    fun `a malformed payload is still rejected first`() {
        PushTokenState.beginReset(context, EdgeContextReset.Reason.OPERATOR_SWITCH, now, 0L)
        val outcome = RemotePushHandler.handle(context, mapOf("v" to "1"), now)
        assertEquals(true, outcome is RemotePushHandler.Outcome.Rejected)
    }
}
