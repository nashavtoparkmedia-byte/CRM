package ru.yokoone.crm.shell

import android.content.Context
import org.junit.Assert.assertTrue
import ru.yokoone.crm.shell.push.PushTokenState
import ru.yokoone.crm.shell.push.TokenActor
import java.security.SecureRandom
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/**
 * Shared fixtures for the edge Basic-auth tests (R5.1).
 *
 * Robolectric has no Android Keystore, so the two HMAC keys live in
 * [MemoryKeys]; everything above the key backend is the production code.
 */
object EdgeTestSupport {

    /** An in-memory stand-in for the Android Keystore, with failure injection. */
    class MemoryKeys : ShellKeys.Backend {
        val keys = HashMap<String, ByteArray>()

        @Volatile
        var failing = false

        override fun exists(alias: String): Boolean = !failing && synchronized(keys) { alias in keys }

        override fun create(alias: String) {
            if (failing) throw IllegalStateException("keystore unavailable")
            val bytes = ByteArray(32).also { SecureRandom().nextBytes(it) }
            synchronized(keys) { keys[alias] = bytes }
        }

        override fun delete(alias: String) {
            synchronized(keys) { keys.remove(alias) }
        }

        override fun hmac(alias: String, data: ByteArray): ByteArray {
            if (failing) throw IllegalStateException("keystore unavailable")
            val key = synchronized(keys) { keys[alias] } ?: throw IllegalStateException("no key")
            return Mac.getInstance("HmacSHA256").run {
                init(SecretKeySpec(key, "HmacSHA256"))
                doFinal(data)
            }
        }
    }

    /**
     * A provider whose calls complete only when the test says so, or at once
     * in [auto] mode. [current] is the provider's truth.
     */
    class FakeProvider(@Volatile var current: String? = null) : TokenActor.Provider {
        @Volatile
        var auto = true

        @Volatile
        var deleteSucceeds = true

        /** What a completed delete leaves as the provider's token (a fresh one, or none). */
        @Volatile
        var afterDelete: String? = null

        /** Per-delete results, consumed in order before [afterDelete] applies. */
        val afterDeleteSequence = java.util.concurrent.ConcurrentLinkedQueue<String>()

        val gets = LinkedBlockingQueue<(String?) -> Unit>()
        val deletes = LinkedBlockingQueue<(Boolean) -> Unit>()

        @Volatile
        var deleteCalls = 0

        @Volatile
        var getCalls = 0

        override fun getToken(listener: (String?) -> Unit) {
            getCalls += 1
            if (auto) listener(current) else gets.put(listener)
        }

        override fun deleteToken(listener: (Boolean) -> Unit) {
            deleteCalls += 1
            if (auto) {
                if (deleteSucceeds) current = afterDeleteSequence.poll() ?: afterDelete
                listener(deleteSucceeds)
            } else {
                deletes.put(listener)
            }
        }

        fun awaitGet(): (String?) -> Unit =
            gets.poll(5, TimeUnit.SECONDS) ?: throw AssertionError("no getToken() was issued")

        fun awaitDelete(): (Boolean) -> Unit =
            deletes.poll(5, TimeUnit.SECONDS) ?: throw AssertionError("no deleteToken() was issued")

        /** Complete the pending delete; on success the provider's token becomes [next]. */
        fun completeDelete(next: String?, ok: Boolean = true) {
            val listener = awaitDelete()
            if (ok) current = next
            listener(ok)
        }

        fun completeGet() {
            awaitGet().invoke(current)
        }

        /** Release anything still waiting, so no test leaves the actor blocked. */
        fun releaseAll() {
            auto = true
            while (true) {
                val delete = deletes.poll()
                val get = gets.poll()
                if (delete == null && get == null) return
                delete?.invoke(false)
                get?.invoke(null)
            }
        }
    }

    lateinit var keys: MemoryKeys

    /** Fresh durable state, keys, process flags and an idle actor. */
    fun reset(context: Context): MemoryKeys {
        assertTrue("token actor did not go idle", TokenActor.awaitIdle(10_000))
        TokenActor.resetForTest()
        context.getSharedPreferences(PushTokenState.PREFS_NAME, Context.MODE_PRIVATE).edit().clear().commit()
        keys = MemoryKeys()
        ShellKeys.backend = keys
        ContinuityGuard.resetForTest()
        ContinuityGuard.state = ContinuityGuard.State.NONE
        EdgeCredentialHolder.resetForTest()
        ShellForeground.started = false
        return keys
    }

    fun useProvider(provider: TokenActor.Provider?) {
        TokenActor.providerFactory = { provider }
    }

    fun idle() = assertTrue("token actor did not go idle", TokenActor.awaitIdle(10_000))
}
