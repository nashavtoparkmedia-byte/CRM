package ru.yokoone.crm.shell.push

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/**
 * The durable half of duplicate suppression.
 *
 * These assert the properties a background push actually depends on: the record
 * survives the object that wrote it, the store stays bounded without a
 * scheduler, and a device clock this app does not control cannot make it grow
 * without limit.
 */
@RunWith(RobolectricTestRunner::class)
class PushDedupStoreTest {

    private val context: Context get() = ApplicationProvider.getApplicationContext()
    private val now = 1_700_000_000_000L

    private fun stored(): Map<String, *> =
        context.getSharedPreferences(PushDedupStore.PREFS_NAME, Context.MODE_PRIVATE).all

    @Test
    fun `a recorded message is remembered and an unknown one is not`() {
        PushDedupStore.record(context, "msg_1", now)
        assertTrue(PushDedupStore.hasSeen(context, "msg_1"))
        assertFalse(PushDedupStore.hasSeen(context, "msg_2"))
    }

    @Test
    fun `entries outlive the retention window by exactly nothing`() {
        PushDedupStore.record(context, "old", now - PushDedupStore.RETENTION_MS - 1)
        PushDedupStore.record(context, "fresh", now - PushDedupStore.RETENTION_MS + 1)

        PushDedupStore.prune(context, now)

        assertFalse(PushDedupStore.hasSeen(context, "old"))
        assertTrue(PushDedupStore.hasSeen(context, "fresh"))
    }

    @Test
    fun `retention covers two full FCM delivery windows`() {
        // P1 sends android.ttl = 43200s. A message the provider may still
        // deliver must never have lost its duplicate protection.
        assertTrue(PushDedupStore.RETENTION_MS >= 2 * 43_200L * 1000L)
    }

    @Test
    fun `a clock that jumps backwards cannot pin an entry forever`() {
        PushDedupStore.record(context, "from_the_future", now + PushDedupStore.RETENTION_MS + 1)
        PushDedupStore.prune(context, now)
        assertFalse(PushDedupStore.hasSeen(context, "from_the_future"))
    }

    @Test
    fun `a value of the wrong type is discarded rather than trusted`() {
        context.getSharedPreferences(PushDedupStore.PREFS_NAME, Context.MODE_PRIVATE)
            .edit().putString("corrupt", "not-a-timestamp").commit()

        PushDedupStore.prune(context, now)

        assertFalse(PushDedupStore.hasSeen(context, "corrupt"))
    }

    @Test
    fun `the store stays bounded and evicts the oldest first`() {
        for (index in 0 until PushDedupStore.MAX_ENTRIES) {
            PushDedupStore.record(context, "msg_$index", now - (PushDedupStore.MAX_ENTRIES - index))
        }
        assertEquals(PushDedupStore.MAX_ENTRIES, stored().size)

        PushDedupStore.record(context, "newest", now)

        assertEquals(PushDedupStore.MAX_ENTRIES, stored().size)
        assertTrue(PushDedupStore.hasSeen(context, "newest"))
        assertFalse("the oldest entry should have been evicted", PushDedupStore.hasSeen(context, "msg_0"))
        assertTrue(PushDedupStore.hasSeen(context, "msg_1"))
    }

    @Test
    fun `the entry being written is never the one evicted`() {
        for (index in 0 until PushDedupStore.MAX_ENTRIES) {
            PushDedupStore.record(context, "msg_$index", now)
        }
        // A skewed clock makes this look older than everything already stored.
        PushDedupStore.record(context, "skewed", now - 1_000_000L)

        assertTrue(PushDedupStore.hasSeen(context, "skewed"))
        assertEquals(PushDedupStore.MAX_ENTRIES, stored().size)
    }
}
