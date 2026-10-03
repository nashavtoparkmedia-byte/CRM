package ru.yokoone.crm.shell.push

import android.content.Context
import kotlin.math.abs

/**
 * Remembers which messages have already produced a notification.
 *
 * Mobile Push v1 is at-least-once by construction: the relay retries, and FCM
 * may deliver the same message more than once. An in-memory guard would not
 * survive the process death that a background push routinely starts from, so
 * the record has to be on disk.
 *
 * SharedPreferences is enough and is therefore all this uses. The store holds
 * at most [MAX_ENTRIES] small entries, has one writer at a time (the caller
 * holds a process lock across check-post-record), needs no query beyond "have I
 * seen this id", and commits the whole file atomically through the platform's
 * backup-file rename. A database would add a dependency, a schema and a
 * migration story for no property this lacks.
 *
 * What this store does NOT promise is exactly-once display. The caller posts
 * the notification first and records afterwards, so a process killed between
 * those two steps can show the same message twice on redelivery. That is the
 * deliberate trade: a narrow duplicate window instead of a window in which a
 * message that was never shown is permanently suppressed.
 */
object PushDedupStore {

    const val PREFS_NAME = "yoko_push_seen"

    /**
     * Two full FCM time-to-live windows. P1 sends android.ttl = 43200s, so a
     * message that the provider is still entitled to deliver can never fall
     * outside the retention window and lose its duplicate protection.
     */
    const val RETENTION_MS = 24L * 60L * 60L * 1000L

    /** Safety bound, not a functional limit. */
    const val MAX_ENTRIES = 512

    private fun prefs(context: Context) =
        context.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    fun hasSeen(context: Context, messageId: String): Boolean = prefs(context).contains(messageId)

    /**
     * Drop everything outside the retention window.
     *
     * The comparison is on absolute distance on purpose. A device clock that
     * moves backwards would otherwise leave entries stamped in the future
     * pinned in the store for as long as the clock stayed behind them; treating
     * "far away in either direction" as expired keeps the store bounded under a
     * clock this app does not control. Timestamps are used for retention only
     * and are never shown or compared against message ordering.
     */
    fun prune(context: Context, now: Long) {
        val store = prefs(context)
        val editor = store.edit()
        var changed = false
        for ((key, value) in store.all) {
            val seenAt = value as? Long
            if (seenAt == null || abs(now - seenAt) > RETENTION_MS) {
                editor.remove(key)
                changed = true
            }
        }
        if (changed) editor.commit()
    }

    /**
     * Record a message as seen, synchronously.
     *
     * commit() rather than apply(): the caller is about to return, possibly
     * from a process the system may kill immediately afterwards, and an
     * unflushed write would reopen exactly the duplicate window the store
     * exists to bound.
     */
    fun record(context: Context, messageId: String, now: Long) {
        val store = prefs(context)
        val editor = store.edit().putLong(messageId, now)

        val entries = HashMap<String, Long>()
        for ((key, value) in store.all) (value as? Long)?.let { entries[key] = it }
        entries[messageId] = now

        val excess = entries.size - MAX_ENTRIES
        if (excess > 0) {
            // Never evict the entry being written, even if a skewed clock makes
            // it look like the oldest: it is the one id whose notification has
            // just been posted, so dropping it would reopen the duplicate
            // window this call exists to close.
            entries.entries
                .filter { it.key != messageId }
                .sortedBy { it.value }
                .take(excess)
                .forEach { editor.remove(it.key) }
        }

        editor.commit()
    }
}
