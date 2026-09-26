package ru.yokoone.crm.shell

import android.content.Intent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Where a notification tap is allowed to land the operator.
 *
 * The scenario that produced this test: a push that arrives after the system
 * has destroyed the shell's Activity but kept its task. Measured on an API 34
 * emulator, the tap relaunched the task's root from the task's own launcher
 * intent - act=MAIN, cats=LAUNCHER, no extras - and onNewIntent never came, so
 * the conversation identifier never reached the shell and it opened the chat
 * list instead. The chat list shows the pushed message as a preview, which is
 * why only the absence of the back-to-list control gave it away.
 *
 * These assertions are about the decision, not about Android: they pin which
 * flags each case uses and, more importantly, that the two cases differ.
 */
class ChatNotificationLaunchTest {

    @Test
    fun `an existing Activity keeps its task and receives the intent`() {
        val flags = ChatNotifications.launchFlagsFor(anyActivityAlive = true)

        assertTrue("must start the task", flags and Intent.FLAG_ACTIVITY_NEW_TASK != 0)
        assertTrue("must reach the instance", flags and Intent.FLAG_ACTIVITY_CLEAR_TOP != 0)
        assertEquals(
            "must not discard a task whose Activity still holds the WebView history",
            0,
            flags and Intent.FLAG_ACTIVITY_CLEAR_TASK,
        )
    }

    @Test
    fun `no Activity means the task is stale and the intent must start it`() {
        val flags = ChatNotifications.launchFlagsFor(anyActivityAlive = false)

        assertTrue("must start the task", flags and Intent.FLAG_ACTIVITY_NEW_TASK != 0)
        assertTrue(
            "the stale task must be cleared, or its own launcher intent starts the Activity " +
                "and the conversation is lost",
            flags and Intent.FLAG_ACTIVITY_CLEAR_TASK != 0,
        )
        assertEquals(
            "CLEAR_TOP is what loses the target on this path",
            0,
            flags and Intent.FLAG_ACTIVITY_CLEAR_TOP,
        )
    }

    @Test
    fun `the two cases are not the same launch`() {
        assertTrue(
            "if these agree, the decision does nothing",
            ChatNotifications.launchFlagsFor(anyActivityAlive = true) !=
                ChatNotifications.launchFlagsFor(anyActivityAlive = false),
        )
    }
}

/**
 * The counter the decision above reads.
 *
 * Nothing else in the shell knows whether an Activity exists, so a counter that
 * drifts sends every tap down the wrong path. The two cases that matter are a
 * second Activity arriving before the first is destroyed, and a destroy the
 * process sees without the matching create - which is what a restarted process
 * can be handed.
 */
class LiveActivitiesTest {

    @Test
    fun `an Activity makes the process hold one, and its destruction releases it`() {
        val before = LiveActivities.any

        LiveActivities.entered()
        assertTrue("an Activity exists", LiveActivities.any)

        LiveActivities.left()
        assertEquals("back to where it started", before, LiveActivities.any)
    }

    @Test
    fun `the second Activity does not release the first`() {
        LiveActivities.entered()
        LiveActivities.entered()
        LiveActivities.left()

        assertTrue("one Activity is still alive", LiveActivities.any)

        LiveActivities.left()
    }

    @Test
    fun `an unmatched destruction cannot drive the count below nothing`() {
        LiveActivities.left()
        LiveActivities.left()
        LiveActivities.left()

        LiveActivities.entered()
        assertTrue(
            "a count pushed negative would report no Activity while one exists",
            LiveActivities.any,
        )

        LiveActivities.left()
    }
}
