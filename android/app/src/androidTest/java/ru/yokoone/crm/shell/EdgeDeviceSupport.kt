package ru.yokoone.crm.shell

import android.content.Context
import android.os.ParcelFileDescriptor
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertTrue
import ru.yokoone.crm.shell.push.PushTokenState
import ru.yokoone.crm.shell.push.TokenActor
import java.security.KeyStore
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

/**
 * Instrumented-layer fixtures for the edge Basic-auth verification (R5.1, I layer).
 *
 * Unlike the JVM tests, nothing here stands in for the platform: the keys are
 * real Android Keystore keys, cookies are the real CookieManager, threads are
 * ART threads. Only the FCM provider is a controllable fake, because the
 * acceptance build has no Firebase project by design.
 */
object EdgeDeviceSupport {

    val context: Context get() = InstrumentationRegistry.getInstrumentation().targetContext

    /** A provider whose calls complete only when the test says so, or at once in [auto] mode. */
    class FakeProvider(@Volatile var current: String? = null) : TokenActor.Provider {
        @Volatile var auto = true
        @Volatile var deleteSucceeds = true
        @Volatile var afterDelete: String? = null
        val afterDeleteSequence = java.util.concurrent.ConcurrentLinkedQueue<String>()
        val gets = LinkedBlockingQueue<(String?) -> Unit>()
        val deletes = LinkedBlockingQueue<(Boolean) -> Unit>()
        @Volatile var deleteCalls = 0
        @Volatile var getCalls = 0

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

        fun awaitGet(): (String?) -> Unit = gets.poll(10, TimeUnit.SECONDS) ?: throw AssertionError("no getToken() issued")
        fun awaitDelete(): (Boolean) -> Unit = deletes.poll(10, TimeUnit.SECONDS) ?: throw AssertionError("no deleteToken() issued")
        fun completeGet() = awaitGet().invoke(current)

        fun releaseAll() {
            auto = true
            while (true) {
                val d = deletes.poll()
                val g = gets.poll()
                if (d == null && g == null) return
                d?.invoke(false)
                g?.invoke(null)
            }
        }
    }

    /** Every Keystore alias the shell owns, removed: a fresh installation's key state. */
    fun deleteShellKeys(prefix: String? = null) {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        for (alias in store.aliases().toList()) {
            val ours = alias.startsWith(ShellKeys.INSTALL_ALIAS_PREFIX) || alias.startsWith(ShellKeys.CONTEXT_ALIAS_PREFIX)
            if (ours && (prefix == null || alias.startsWith(prefix))) store.deleteEntry(alias)
        }
    }

    fun shellAliases(prefix: String): List<String> {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        return store.aliases().toList().filter { it.startsWith(prefix) }
    }

    /** Fresh durable state, real keys removed, process flags reset, actor idle. */
    fun reset() {
        assertTrue("token actor did not go idle", TokenActor.awaitIdle(15_000))
        TokenActor.resetForTest()
        context.getSharedPreferences(PushTokenState.PREFS_NAME, Context.MODE_PRIVATE).edit().clear().commit()
        deleteShellKeys()
        ContinuityGuard.resetForTest()
        ContinuityGuard.state = ContinuityGuard.State.NONE
        EdgeCredentialHolder.resetForTest()
        EdgeChallengeCoordinator.ProcessFacts.resetForTest()
        ShellForeground.started = false
    }

    fun useProvider(provider: TokenActor.Provider?) {
        TokenActor.providerFactory = { provider }
    }

    fun idle() = assertTrue("token actor did not go idle", TokenActor.awaitIdle(15_000))

    /** The shell's diagnostics lines in logcat, with the pid that wrote each. */
    fun diagnostics(): List<Pair<Int, String>> {
        val fd = InstrumentationRegistry.getInstrumentation().uiAutomation
            .executeShellCommand("logcat -d -v brief -s ${ShellDiagnostics.TAG}:E")
        val text = ParcelFileDescriptor.AutoCloseInputStream(fd).use { it.readBytes().toString(Charsets.UTF_8) }
        val line = Regex("""^E/${ShellDiagnostics.TAG}\(\s*(\d+)\):\s?(.*)$""")
        return text.lineSequence().mapNotNull { l -> line.find(l.trimEnd())?.let { it.groupValues[1].toInt() to it.groupValues[2] } }.toList()
    }

    /** One line where the workflow lifts it out of logcat. */
    fun mark(line: String) = ShellDiagnostics.write("I-VERIFY $line")
}
