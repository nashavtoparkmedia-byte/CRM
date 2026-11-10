package ru.yokoone.crm.shell.push

import android.content.Context
import androidx.annotation.VisibleForTesting
import ru.yokoone.crm.shell.ShellDiagnostics
import ru.yokoone.crm.shell.ShellTestHooks
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * The one serial token actor of this process (R5.1 §5.7.2, INV-20, INV-22).
 *
 * Every provider call (`deleteToken`, `getToken`) and every token commit runs
 * here, one job at a time, on one thread. Nothing else talks to the provider or
 * writes the newest token:
 *
 *  - provider callbacks only signal — `onNewToken` and the process-start fetch
 *    enqueue a coalesced REFRESH and never pass their value on;
 *  - a delete is awaited until its task completes, success or failure; no
 *    timeout lets the actor move on while a delete is outstanding (the reset's
 *    own delete is the one exception, because the process ends right after);
 *  - every job ends by reading the provider with `getToken()`, so the value
 *    committed is the provider's current token after every delete this process
 *    issued has completed;
 *  - the commit is a compare-and-set on the reset epoch and the retired set
 *    under [PushTokenState.LOCK] ([PushTokenState.commitToken]);
 *  - a listener that fires after its job ended is ignored.
 *
 * No correctness property depends on cancelling a coroutine, a Task or
 * WorkManager work. The queue, job numbers and round counters are memory only;
 * everything that must survive process death is durable in [PushTokenState].
 */
object TokenActor {

    enum class Kind { ROTATE, REFRESH, RETIRE_AND_ROTATE, RECOVER_KEY, RESET_DELETE }

    /** The provider surface the actor needs. Listeners may be called on any thread, at most once each. */
    interface Provider {
        fun getToken(listener: (String?) -> Unit)
        fun deleteToken(listener: (Boolean) -> Unit)
    }

    const val GET_TIMEOUT_MS = 30_000L

    /** §5.7.2 item 6: at most two delete+get rounds per process. */
    const val MAX_ROTATION_ROUNDS = 2

    private const val MAX_KEY_RECOVERIES = 3

    @Volatile
    @VisibleForTesting
    var providerFactory: (Context) -> Provider? = { defaultProvider(it) }

    @Volatile
    @VisibleForTesting
    var getTimeoutMs: Long = GET_TIMEOUT_MS

    private class Job(val kind: Kind, val ticket: PushTokenState.Ticket?, val done: CountDownLatch?)

    private class Admitted(val job: Job, val epoch: Long, val seq: Long)

    // Guarded by PushTokenState.LOCK, the only lock on this path.
    private val queue = ArrayDeque<Job>()
    private var running: Admitted? = null
    private var draining = false
    private var jobSeq = 0L
    private var rotationRounds = 0
    private var keyRecoveries = 0

    private val started = AtomicBoolean(false)

    private val executor = Executors.newSingleThreadExecutor { runnable ->
        Thread(runnable, "yoko-token-actor").apply { isDaemon = true }
    }

    private fun defaultProvider(context: Context): Provider? =
        ShellTestHooks.tokenProviderOverride(context)
            ?: if (FcmTokenProvider.isConfigured(context)) FcmTokenProvider.Firebase else null

    // ── triggers ───────────────────────────────────────────────────────────

    /** Main-process start (never `:reset`): ROTATE if pending, otherwise one REFRESH. */
    fun onMainProcessStart(context: Context) {
        if (!started.compareAndSet(false, true)) return
        if (PushTokenState.resetPending(context) != null) return
        if (needsKeyRecovery(context)) {
            enqueue(context, Kind.RECOVER_KEY)
        } else if (PushTokenState.rotationPending(context)) {
            enqueue(context, Kind.ROTATE)
        } else {
            enqueue(context, Kind.REFRESH)
        }
    }

    /** onStart, connectivity regained, reset completion: drive a pending rotation. */
    fun onRotationTrigger(context: Context) {
        if (PushTokenState.resetPending(context) != null) return
        if (needsKeyRecovery(context)) {
            enqueue(context, Kind.RECOVER_KEY)
        } else if (PushTokenState.rotationPending(context)) {
            enqueue(context, Kind.ROTATE)
        }
    }

    /** `onNewToken` and the process-start fetch: a signal, never a value. */
    fun signalRefresh(context: Context) = enqueue(context, Kind.REFRESH)

    /** §5.7.4: only [PushRegistrationWork] after a RECOVER result of applyConflictIfCurrent. */
    fun enqueueRetireAndRotate(context: Context, ticket: PushTokenState.Ticket) =
        enqueue(context, Kind.RETIRE_AND_ROTATE, ticket)

    /**
     * Reset step 5a. Returns a latch the reset may wait on for at most 5 s; the
     * job goes to the front of the queue but still waits for a job in progress.
     */
    fun requestResetDelete(context: Context): CountDownLatch {
        val done = CountDownLatch(1)
        enqueue(context, Kind.RESET_DELETE, null, done, front = true)
        return done
    }

    /** True while a rotation-family job runs or is queued (§5.7.2 item 9). Call under [PushTokenState.LOCK]. */
    internal fun busyForRegistrationLocked(): Boolean {
        val active = running?.job?.kind
        if (active != null && active != Kind.REFRESH) return true
        return queue.any { it.kind != Kind.REFRESH }
    }

    fun isBusyForRegistration(): Boolean = synchronized(PushTokenState.LOCK) { busyForRegistrationLocked() }

    private fun needsKeyRecovery(context: Context): Boolean =
        PushTokenState.snapshot(context).installKeyRecoveryPending || PushTokenState.installKeyBroken(context)

    private fun enqueue(
        context: Context,
        kind: Kind,
        ticket: PushTokenState.Ticket? = null,
        done: CountDownLatch? = null,
        front: Boolean = false,
    ) {
        val app = context.applicationContext
        val startDrain = synchronized(PushTokenState.LOCK) {
            val coalesce = kind != Kind.RETIRE_AND_ROTATE && kind != Kind.RESET_DELETE && queue.any { it.kind == kind }
            if (!coalesce) {
                val job = Job(kind, ticket, done)
                if (front) queue.addFirst(job) else queue.addLast(job)
            }
            if (draining) {
                false
            } else {
                draining = true
                true
            }
        }
        if (startDrain) executor.execute { drain(app) }
    }

    private fun drain(context: Context) {
        while (true) {
            val admitted = synchronized(PushTokenState.LOCK) {
                val next = queue.removeFirstOrNull()
                if (next == null) {
                    draining = false
                    running = null
                    null
                } else {
                    // Admission: the job's reset epoch and sequence, under the lock.
                    Admitted(next, PushTokenState.resetEpoch(context), ++jobSeq).also { running = it }
                }
            } ?: return
            try {
                run(context, admitted)
            } catch (error: RuntimeException) {
                ShellDiagnostics.write("YOKO_NET fail push-token job=${admitted.job.kind} error=${error.javaClass.simpleName}")
            } finally {
                synchronized(PushTokenState.LOCK) { running = null }
                admitted.job.done?.countDown()
            }
        }
    }

    private fun run(context: Context, job: Admitted) {
        when (job.job.kind) {
            Kind.REFRESH -> {
                val token = read(context, job) ?: return
                commit(context, job, PushTokenState.CommitKind.REFRESH, token, deleted = false)
            }

            Kind.ROTATE -> {
                // Re-read under the lock immediately before deleteToken(); end
                // without calling it if the rotation is no longer owed.
                val proceed = synchronized(PushTokenState.LOCK) {
                    val owed = PushTokenState.rotationPending(context) && PushTokenState.resetPending(context) == null
                    if (owed && rotationRounds < MAX_ROTATION_ROUNDS) {
                        rotationRounds += 1
                        true
                    } else {
                        if (owed) ShellDiagnostics.write("YOKO_NET fail push-rotation still-retired")
                        false
                    }
                }
                if (!proceed) return
                if (!delete(context, job)) return
                val token = read(context, job) ?: return
                commit(context, job, PushTokenState.CommitKind.ROTATE, token, deleted = true)
            }

            Kind.RETIRE_AND_ROTATE -> {
                val ticket = job.job.ticket ?: return
                // D-1: the 409 ticket must still be current when the job starts.
                if (!PushTokenState.beginConflictRecoveryIfCurrent(context, ticket)) {
                    ShellDiagnostics.write("YOKO_NET fail push-rotation recovery-stale")
                    return
                }
                if (!delete(context, job)) return
                val token = read(context, job) ?: return
                commit(context, job, PushTokenState.CommitKind.RETIRE_AND_ROTATE, token, deleted = true)
            }

            Kind.RECOVER_KEY -> {
                val allowed = synchronized(PushTokenState.LOCK) {
                    if (keyRecoveries < MAX_KEY_RECOVERIES) {
                        keyRecoveries += 1
                        true
                    } else {
                        false
                    }
                }
                if (!allowed) return
                if (!PushTokenState.beginInstallKeyRecovery(context)) {
                    ShellDiagnostics.write("YOKO_NET fail push-token keystore-unavailable")
                    return
                }
                // A token is accepted only after a delete that completed
                // successfully in this same job.
                if (!delete(context, job)) return
                val token = read(context, job) ?: return
                commit(context, job, PushTokenState.CommitKind.RECOVER_KEY, token, deleted = true)
            }

            Kind.RESET_DELETE -> {
                if (delete(context, job)) PushTokenState.markDeleteConfirmed(context)
            }
        }
    }

    private fun commit(context: Context, job: Admitted, kind: PushTokenState.CommitKind, token: String, deleted: Boolean) {
        when (val result = PushTokenState.commitToken(context, job.epoch, kind, token, deleted)) {
            is PushTokenState.CommitResult.Committed -> {
                ShellDiagnostics.write("YOKO_NET done POST push-token commit kind=$kind changed=${result.changed}")
                PushRegistration.requestIfNeeded(context, result.snapshot)
            }

            is PushTokenState.CommitResult.Rejected -> {
                ShellDiagnostics.write("YOKO_NET fail push-token rejected kind=$kind reason=${result.reason}")
                when (result.reason) {
                    "key-unavailable", "key-recovery-pending" -> enqueue(context, Kind.RECOVER_KEY)
                    "retired" -> if (PushTokenState.rotationPending(context)) enqueue(context, Kind.ROTATE)
                }
            }
        }
    }

    /** getToken(), bounded; a late result is ignored by sequence. */
    private fun read(context: Context, job: Admitted): String? {
        val provider = providerFactory(context) ?: return null
        val box = Await<String?>(job.seq, "get")
        val issued = runCatching { provider.getToken { box.complete(it) } }.isSuccess
        if (!issued) return null
        val value = box.await(getTimeoutMs)
        return value?.takeIf { it.isNotEmpty() }
    }

    /** deleteToken(), awaited until it completes. Returns true only for a confirmed success. */
    private fun delete(context: Context, job: Admitted): Boolean {
        val provider = providerFactory(context) ?: return false
        val box = Await<Boolean>(job.seq, "delete")
        val issued = runCatching { provider.deleteToken { box.complete(it) } }.isSuccess
        if (!issued) return false
        return box.await(null) == true
    }

    /** One provider call's result, delivered once, ignored after its job gave up on it. */
    private class Await<T>(private val seq: Long, private val what: String) {
        private val latch = CountDownLatch(1)
        private val delivered = AtomicBoolean(false)

        @Volatile
        private var abandoned = false

        @Volatile
        private var value: T? = null

        fun complete(result: T?) {
            if (!delivered.compareAndSet(false, true)) return
            if (abandoned) {
                ShellDiagnostics.write("YOKO_NET fail push-token late-listener $what job=$seq ignored")
                return
            }
            value = result
            latch.countDown()
        }

        fun await(timeoutMs: Long?): T? {
            if (timeoutMs == null) {
                latch.await()
            } else if (!latch.await(timeoutMs, TimeUnit.MILLISECONDS)) {
                abandoned = true
                // A result that raced the timeout is still ignored: the job has
                // already decided to end without a commit.
                return null
            }
            return value
        }
    }

    // ── test support ───────────────────────────────────────────────────────

    @VisibleForTesting
    fun awaitIdle(timeoutMs: Long = 5_000L): Boolean {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            val idle = synchronized(PushTokenState.LOCK) { !draining && queue.isEmpty() && running == null }
            if (idle) return true
            Thread.sleep(5)
        }
        return false
    }

    @VisibleForTesting
    fun queuedKinds(): List<Kind> = synchronized(PushTokenState.LOCK) { queue.map { it.kind } }

    @VisibleForTesting
    fun runningKind(): Kind? = synchronized(PushTokenState.LOCK) { running?.job?.kind }

    /** Forget per-process counters; call only when [awaitIdle] returned true. */
    @VisibleForTesting
    fun resetForTest() {
        synchronized(PushTokenState.LOCK) {
            queue.clear()
            rotationRounds = 0
            keyRecoveries = 0
        }
        started.set(false)
        providerFactory = { defaultProvider(it) }
        getTimeoutMs = GET_TIMEOUT_MS
    }
}
